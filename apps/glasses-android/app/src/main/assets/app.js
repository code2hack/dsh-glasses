/* G0 WebView logic: native-authenticated bootstrap, one SSE projection,
 * sequence de-duplication, and bootstrap-first recovery. No writes. */
'use strict';

const $ = (id) => document.getElementById(id);
let streamOpen = false;
let streamConnecting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let recovering = false;
let generation = '';
let lastSeq = -1;
const seenSeqs = new Set();

function trace(name, fields) {
  console.info('DSH_G0 ' + name + ' ' + JSON.stringify(fields || {}));
}

function showProvision(show) {
  $('provision').classList.toggle('hidden', !show);
}

function showSession(show) {
  $('session').classList.toggle('hidden', !show);
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

function init() {
  trace('init');
  $('save').addEventListener('click', () => {
    window.GlassesBridge.configure($('in-base').value, $('in-token').value, $('in-session').value);
    $('in-token').value = '';
    trace('configured', { endpoint: window.GlassesBridge.endpoint(), session: window.GlassesBridge.sessionId() });
    run();
  });

  window.glassesOnLine = (event, data, id) => {
    let decoded = data;
    try { decoded = JSON.parse(data); } catch (_) {}

    if (event === 'hello') {
      trace('sse-hello', { generation: decoded && decoded.serverGeneration });
      if (decoded && decoded.serverGeneration && generation && decoded.serverGeneration !== generation) {
        recoverSnapshot('generation-change');
      }
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
    if (state === 'open') {
      streamOpen = true;
      streamConnecting = false;
      reconnectAttempt = 0;
      cancelReconnect();
      setConn('open', 'live');
      // Close the bootstrap→subscribe race: once SSE is definitely open, take
      // another authoritative snapshot. Queued SSE events are de-duplicated by seq.
      recoverSnapshot('stream-open');
      return;
    }

    streamOpen = false;
    streamConnecting = false;
    scheduleReconnect(state === 'closed' ? 'closed·reconnect' : ('offline' + (detail ? '·' + detail : '')));
  };

  window.onNativeTrace = (line) => {
    $('tracebox').textContent = (line + '\n' + $('tracebox').textContent).slice(0, 6000);
  };

  run();
}

function run() {
  const endpoint = window.GlassesBridge.endpoint();
  if (!endpoint) {
    showProvision(true);
    showSession(false);
    setConn('off', 'configure');
    trace('not-configured');
    return;
  }

  const snapshot = fetchSnapshot();
  if (!snapshot) return;
  showProvision(false);
  showSession(true);
  applySnapshot(snapshot);

  if (!streamOpen && !streamConnecting) {
    streamConnecting = true;
    setConn('reconnecting', 'connecting');
    trace('stream-opening', { lastSeq: lastSeq });
    window.GlassesBridge.openStream();
  }
}

function fetchSnapshot() {
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
    const expectedSession = window.GlassesBridge.sessionId();
    if (expectedSession && snapshot.attachment.sessionId !== expectedSession) {
      trace('session-mismatch', { expected: expectedSession, actual: snapshot.attachment.sessionId });
      setConn('off', 'session-mismatch');
      showProvision(true);
      showSession(false);
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
    generation: generation,
    asOfSeq: lastSeq,
    eventCount: events.length,
    status: snapshot.attachment.status,
    writeState: snapshot.writeState || null,
  });
}

function recoverSnapshot(reason) {
  if (recovering) {
    trace('recovery-coalesced', { reason: reason });
    return;
  }
  recovering = true;
  trace('recovery-start', { reason: reason, streamOpen: streamOpen, lastSeq: lastSeq });
  setConn(streamOpen ? 'open' : 'reconnecting', streamOpen ? 'live·sync' : reason);
  try {
    const snapshot = fetchSnapshot();
    if (snapshot) {
      showProvision(false);
      showSession(true);
      applySnapshot(snapshot);
      if (streamOpen) setConn('open', 'live');
      trace('recovery-complete', { reason: reason, lastSeq: lastSeq });
    }
  } finally {
    recovering = false;
  }
}

function renderProjection(event) {
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
  if (!event || event === 'message') return;
  const li = document.createElement('li');
  li.className = 'ev raw';
  li.textContent = event + (id ? ' #' + id : '') + ' ' + JSON.stringify(data);
  $('events').prepend(li);
  trace('sse-raw', { event: event, id: id || null });
}

function scheduleReconnect(label) {
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
