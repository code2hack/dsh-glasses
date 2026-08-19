/* G0 WebView logic: native-authenticated bootstrap, one SSE projection,
 * sequence de-duplication, and bootstrap-first recovery. No writes. */
'use strict';

const $ = (id) => document.getElementById(id);
let streamOpen = false;
let streamConnecting = false;
let streamVerified = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let helloTimer = null;
let recovering = false;
let generation = '';
let lastSeq = -1;
let identityFailure = null;
const seenSeqs = new Set();

function trace(name, fields) {
  console.info('DSH_G0 ' + name + ' ' + JSON.stringify(fields || {}));
}

function configuredEndpoint() {
  try { return String(window.GlassesBridge.endpoint() || '').trim(); }
  catch (_) { return ''; }
}

function configuredSession() {
  try { return String(window.GlassesBridge.sessionId() || '').trim(); }
  catch (_) { return ''; }
}

function showProvision(show) {
  $('provision').classList.toggle('hidden', !show);
}

function showSession(show) {
  $('session').classList.toggle('hidden', !show);
}

function showIdentityError(show, expected, actual) {
  $('identity-error').classList.toggle('hidden', !show);
  $('identity-expected').textContent = show ? (expected || '(not configured)') : '';
  $('identity-actual').textContent = show ? (actual || '(missing from endpoint)') : '';
}

function clearSessionProjection() {
  generation = '';
  lastSeq = -1;
  seenSeqs.clear();
  $('session-id').textContent = '';
  $('proto').textContent = '';
  $('gen').textContent = '';
  $('asof').textContent = '';
  $('status').textContent = '';
  $('wsv').textContent = '';
  $('events').innerHTML = '';
}

function setConn(state, text) {
  const dot = $('conn');
  dot.className = 'dot ' + (state === 'open' ? 'on' : state === 'reconnecting' ? 'mid' : 'off');
  dot.textContent = text;
}

function nativeFetch(path, body) {
  try {
    return JSON.parse(window.GlassesBridge.fetch(path, body || ''));
  } catch (error) {
    return { status: 0, body: String(error) };
  }
}

function cancelHelloTimer() {
  if (helloTimer !== null) clearTimeout(helloTimer);
  helloTimer = null;
}

function stopTransport(reason) {
  cancelHelloTimer();
  cancelReconnect();
  streamOpen = false;
  streamConnecting = false;
  streamVerified = false;
  try { window.GlassesBridge.closeStream(); } catch (_) {}
  trace('transport-stopped', { reason: reason || 'unspecified' });
}

/**
 * Session identity is a hard boundary. Once mismatched, server content is
 * hidden, the native stream is canceled, and automatic retry is disabled until
 * provisioning is explicitly changed (or the page is reloaded with a corrected
 * app-private session id).
 */
function enterSessionMismatch(expected, actual, source) {
  identityFailure = {
    expected: expected || '',
    actual: actual || '',
    source: source || 'unknown',
  };
  stopTransport('session-mismatch');
  clearSessionProjection();
  showSession(false);
  showProvision(true);
  showIdentityError(true, identityFailure.expected, identityFailure.actual);
  setConn('off', 'session-mismatch');
  trace('session-mismatch', identityFailure);
}

function clearIdentityFailure(reason) {
  if (identityFailure) trace('session-mismatch-cleared', { reason: reason || 'reconfigure' });
  identityFailure = null;
  showIdentityError(false, '', '');
}

function init() {
  trace('init');
  $('in-base').value = configuredEndpoint();
  $('in-session').value = configuredSession();
  trace('configuration-loaded', {
    endpoint: configuredEndpoint(),
    expectedSession: configuredSession(),
  });

  $('save').addEventListener('click', () => {
    const requestedBase = $('in-base').value.trim();
    const requestedSession = $('in-session').value.trim();
    stopTransport('reconfigure');
    clearIdentityFailure('save');

    const committed = Boolean(
      window.GlassesBridge.configure(requestedBase, $('in-token').value, requestedSession),
    );
    $('in-token').value = '';
    const storedSession = configuredSession();
    trace('configure-result', {
      committed: committed,
      requestedSession: requestedSession,
      storedSession: storedSession,
      endpoint: configuredEndpoint(),
    });

    if (!committed || storedSession !== requestedSession) {
      enterSessionMismatch(requestedSession, storedSession || '(not persisted)', 'configuration');
      return;
    }
    run();
  });

  window.glassesOnSemanticControl = (name) => {
    trace('semantic-control-injected', { source: 'debug-seam', name: String(name || '').slice(0, 48), time: Date.now() });
  };

  window.glassesOnLine = (event, data, id) => {
    if (identityFailure) {
      trace('sse-ignored-identity-failure', { event: event || null, id: id || null });
      return;
    }

    let decoded = data;
    try { decoded = JSON.parse(data); } catch (_) {}

    if (event === 'hello') {
      const expected = configuredSession();
      const actual = decoded && typeof decoded === 'object'
        ? String(decoded.sessionId || '').trim()
        : '';
      trace('sse-hello', {
        expectedSession: expected,
        actualSession: actual,
        generation: decoded && decoded.serverGeneration,
      });

      if (!expected || actual !== expected) {
        enterSessionMismatch(expected, actual, 'sse-hello');
        return;
      }

      streamVerified = true;
      cancelHelloTimer();
      if (decoded.serverGeneration && generation && decoded.serverGeneration !== generation) {
        recoverSnapshot('generation-change');
        return;
      }
      setConn('open', 'live');
      // Close the bootstrap→subscribe race only after the SSE peer proves the
      // same session identity as the configured bootstrap target.
      recoverSnapshot('stream-open');
      return;
    }

    if (!streamVerified) {
      trace('sse-event-before-identity', { event: event || null, id: id || null });
      return;
    }

    if (event === 'gap') {
      trace('sse-gap', decoded);
      recoverSnapshot('server-gap');
      return;
    }
    if (event !== 'projection' || !decoded || typeof decoded !== 'object') {
      renderRaw(event, decoded, id);
      return;
    }

    if (decoded.generation && generation && decoded.generation !== generation) {
      trace('projection-generation-mismatch', { expected: generation, actual: decoded.generation, seq: decoded.seq });
      recoverSnapshot('projection-generation-change');
      return;
    }

    const seq = Number(decoded.seq);
    if (!Number.isFinite(seq)) {
      trace('projection-invalid-seq', { id: id, data: decoded });
      renderRaw(event, decoded, id);
      return;
    }
    if (seq <= lastSeq || seenSeqs.has(seq)) {
      trace('projection-deduplicated', { seq: seq, lastSeq: lastSeq });
      return;
    }
    if (lastSeq >= 0 && seq !== lastSeq + 1) {
      trace('projection-client-gap', { lastSeq: lastSeq, nextSeq: seq });
      recoverSnapshot('client-sequence-gap');
      return;
    }
    renderProjection(decoded);
  };

  window.glassesOnStream = (state, detail) => {
    trace('stream-state', { state: state, detail: detail || null, lastSeq: lastSeq });

    if (identityFailure) {
      try { window.GlassesBridge.closeStream(); } catch (_) {}
      trace('stream-state-ignored-identity-failure', { state: state });
      return;
    }

    if (state === 'open') {
      streamOpen = true;
      streamConnecting = false;
      streamVerified = false;
      reconnectAttempt = 0;
      cancelReconnect();
      setConn('reconnecting', 'verifying');
      armHelloTimeout();
      return;
    }

    streamOpen = false;
    streamConnecting = false;
    streamVerified = false;
    cancelHelloTimer();
    scheduleReconnect(state === 'closed' ? 'closed·reconnect' : ('offline' + (detail ? '·' + detail : '')));
  };

  window.onNativeTrace = (line) => {
    $('tracebox').textContent = (line + '\n' + $('tracebox').textContent).slice(0, 6000);
  };

  // Read-only CDP aid: contains no bearer token.
  window.g0DebugState = () => ({
    endpoint: configuredEndpoint(),
    expectedSession: configuredSession(),
    identityFailure: identityFailure ? { ...identityFailure } : null,
    streamOpen: streamOpen,
    streamVerified: streamVerified,
    generation: generation,
    lastSeq: lastSeq,
  });

  run();
}

function run() {
  if (identityFailure) {
    setConn('off', 'session-mismatch');
    return;
  }

  const endpoint = configuredEndpoint();
  const expectedSession = configuredSession();
  if (!endpoint || !expectedSession) {
    showProvision(true);
    showSession(false);
    showIdentityError(false, '', '');
    setConn('off', 'configure');
    trace('not-configured', { endpointPresent: Boolean(endpoint), sessionPresent: Boolean(expectedSession) });
    return;
  }

  const snapshot = fetchSnapshot();
  if (!snapshot) return;
  showProvision(false);
  showIdentityError(false, '', '');
  showSession(true);
  applySnapshot(snapshot);

  if (!streamOpen && !streamConnecting) {
    streamConnecting = true;
    streamVerified = false;
    setConn('reconnecting', 'connecting');
    trace('stream-opening', { lastSeq: lastSeq, expectedSession: expectedSession });
    window.GlassesBridge.openStream();
  }
}

function fetchSnapshot() {
  if (identityFailure) return null;

  const response = nativeFetch('/glasses/v1/bootstrap', '');
  if (response.status !== 200) {
    trace('bootstrap-failed', { status: response.status });
    if (response.status === 401 || response.status === 403) {
      showProvision(true);
      showSession(false);
    }
    scheduleReconnect(response.status === 0 ? 'unreachable' : ('HTTP ' + response.status));
    return null;
  }

  try {
    const snapshot = JSON.parse(response.body);
    const expectedSession = configuredSession();
    const actualSession = snapshot && snapshot.attachment
      ? String(snapshot.attachment.sessionId || '').trim()
      : '';
    if (!expectedSession || actualSession !== expectedSession) {
      enterSessionMismatch(expectedSession, actualSession, 'bootstrap');
      return null;
    }
    return snapshot;
  } catch (error) {
    trace('bootstrap-invalid-json', { message: String(error) });
    scheduleReconnect('bad-bootstrap');
    return null;
  }
}

function applySnapshot(snapshot) {
  if (identityFailure) return;
  showSession(true);
  generation = snapshot.serverGeneration || '';
  lastSeq = Number(snapshot.history && snapshot.history.asOfSeq);
  if (!Number.isFinite(lastSeq)) lastSeq = -1;
  seenSeqs.clear();

  $('session-id').textContent = snapshot.attachment.sessionId.slice(0, 12) + '…';
  $('proto').textContent = snapshot.protocolMajor;
  $('gen').textContent = generation.slice(0, 10);
  $('asof').textContent = lastSeq;
  $('status').textContent = snapshot.attachment.status;
  $('wsv').textContent = snapshot.writeState || '-';
  $('events').innerHTML = '';

  const events = (snapshot.history && snapshot.history.events) || [];
  events.slice(-30).forEach((event) => {
    const seq = Number(event.seq);
    if (Number.isFinite(seq)) seenSeqs.add(seq);
    addEventRow(event);
  });
  trace('bootstrap-applied', {
    session: snapshot.attachment.sessionId,
    generation: generation,
    asOfSeq: lastSeq,
    eventCount: events.length,
    status: snapshot.attachment.status,
    writeState: snapshot.writeState || null,
  });
}

function recoverSnapshot(reason) {
  if (identityFailure) {
    trace('recovery-blocked-identity-failure', { reason: reason });
    return;
  }
  if (recovering) {
    trace('recovery-coalesced', { reason: reason });
    return;
  }
  recovering = true;
  trace('recovery-start', { reason: reason, streamOpen: streamOpen, streamVerified: streamVerified, lastSeq: lastSeq });
  setConn(streamVerified ? 'open' : 'reconnecting', streamVerified ? 'live·sync' : reason);
  try {
    const snapshot = fetchSnapshot();
    if (snapshot) {
      showProvision(false);
      showIdentityError(false, '', '');
      showSession(true);
      applySnapshot(snapshot);
      if (streamVerified) setConn('open', 'live');
      trace('recovery-complete', { reason: reason, lastSeq: lastSeq });
    }
  } finally {
    recovering = false;
  }
}

function renderProjection(event) {
  if (identityFailure || !streamVerified) return;
  const seq = Number(event.seq);
  seenSeqs.add(seq);
  lastSeq = Math.max(lastSeq, seq);
  $('asof').textContent = lastSeq;
  addEventRow(event);
  trace('projection-applied', { seq: seq, type: event.type || '' });
}

function addEventRow(event) {
  const li = document.createElement('li');
  li.className = 'ev';
  li.textContent = '#' + (event.seq != null ? event.seq : '?') + ' ' + (event.type || '');
  if (event.seq != null) li.setAttribute('data-seq', event.seq);
  $('events').prepend(li);
  while ($('events').children.length > 100) $('events').removeChild($('events').lastChild);
}

function renderRaw(event, data, id) {
  if (!event || event === 'message' || identityFailure) return;
  const li = document.createElement('li');
  li.className = 'ev raw';
  li.textContent = event + (id ? ' #' + id : '') + ' ' + JSON.stringify(data);
  $('events').prepend(li);
  trace('sse-raw', { event: event, id: id || null });
}

function armHelloTimeout() {
  cancelHelloTimer();
  helloTimer = setTimeout(() => {
    helloTimer = null;
    if (identityFailure || !streamOpen || streamVerified) return;
    trace('sse-hello-timeout', { expectedSession: configuredSession() });
    streamOpen = false;
    streamConnecting = false;
    try { window.GlassesBridge.closeStream(); } catch (_) {}
    scheduleReconnect('identity-timeout');
  }, 8_000);
}

function scheduleReconnect(label) {
  if (identityFailure) {
    trace('reconnect-blocked-identity-failure', { label: label });
    return;
  }
  setConn('reconnecting', label);
  if (reconnectTimer !== null) return;
  const delay = Math.min(10_000, 1_000 * Math.pow(2, reconnectAttempt++));
  trace('reconnect-scheduled', { label: label, delayMs: delay, attempt: reconnectAttempt });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    run();
  }, delay);
}

function cancelReconnect() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
