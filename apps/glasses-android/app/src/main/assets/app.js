/* C0 WebView: authenticated bootstrap/SSE recovery, text conversation folding,
 * plugin-authoritative draft mutation, and Send-only action settlement.
 * Physical bindings remain unqualified; the reducer is initially driven through
 * the DEBUG-only native semantic-control seam. */
'use strict';

const $ = (id) => document.getElementById(id);
const core = window.C0Core;
if (!core) throw new Error('C0Core is unavailable');
const staging = window.GlassesSnapshotCore;
if (!staging) throw new Error('GlassesSnapshotCore is unavailable');

// M1 (#27) is a strictly READ-ONLY milestone: one attached session, canonical
// snapshot bootstrap, no SSE, no draft mutations, no actions. Every TB0/M3
// write path below remains SOURCE but must have zero reachable effect in M1.
const M1_READ_ONLY = true;

const MUTATION_KEY_PREFIX = 'dsh.c0.pending.mutation.';
const SEND_KEY_PREFIX = 'dsh.c0.pending.send.';

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
let hasInstalled = false;
const seenSeqs = new Set();

let mode = 'navigation';
let hudVisible = true;
let wheelOpen = false;
let wheelSelection = null;
let cursorWord = 0;
let sessionStatus = 'unavailable';
let writeState = 'ready';
let authoritativeDraft = { revision: 0, text: '', locked: false };
let actionMessage = '';
let actionTone = '';

// The installed conversation is replaced wholesale (atomically) by
// installSnapshot() adopting the staged detached state.
let conversation = core.createConversationState();
let pendingMutation = null;
let pendingSend = null;
let mutationInFlight = false;
let sendInFlight = false;
let mutationRetryTimer = null;
let sendRetryTimer = null;

function trace(name, fields) {
  console.info('DSH_C0 ' + name + ' ' + JSON.stringify(fields || {}));
}

function configuredEndpoint() {
  try { return String(window.GlassesBridge.endpoint() || '').trim(); }
  catch (_) { return ''; }
}

function configuredSession() {
  try { return String(window.GlassesBridge.sessionId() || '').trim(); }
  catch (_) { return ''; }
}

function storageKey(prefix, sessionId) {
  return prefix + encodeURIComponent(sessionId || '(unconfigured)');
}

function readStored(prefix, sessionId) {
  try {
    const raw = localStorage.getItem(storageKey(prefix, sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeStored(prefix, sessionId, value) {
  try {
    const key = storageKey(prefix, sessionId);
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    trace('local-storage-failed', { kind: prefix.includes('mutation') ? 'mutation' : 'send', message: String(error) });
  }
}

function loadPendingForConfiguredSession() {
  const sessionId = configuredSession();
  pendingMutation = sessionId ? readStored(MUTATION_KEY_PREFIX, sessionId) : null;
  pendingSend = sessionId ? readStored(SEND_KEY_PREFIX, sessionId) : null;
  trace('pending-loaded', {
    mutation: pendingMutation?.body?.operationId || null,
    send: pendingSend?.body?.operationId || null,
  });
}

function persistPendingMutation() {
  writeStored(MUTATION_KEY_PREFIX, configuredSession(), pendingMutation);
}

function persistPendingSend() {
  writeStored(SEND_KEY_PREFIX, configuredSession(), pendingSend);
}

function clearPendingMutation() {
  pendingMutation = null;
  persistPendingMutation();
  cancelMutationRetry();
}

function clearPendingSend() {
  pendingSend = null;
  persistPendingSend();
  cancelSendRetry();
}

function newOperationId(prefix) {
  let suffix = '';
  try {
    suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '';
  } catch (_) {}
  if (!suffix) {
    suffix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 11);
  }
  return prefix + '-' + suffix;
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

function setConn(state, label) {
  const node = $('conn');
  node.className = 'conn ' + (state === 'open' ? 'on' : state === 'reconnecting' ? 'mid' : 'off');
  node.textContent = label;
}

function setAction(message, tone) {
  actionMessage = String(message || '');
  actionTone = tone || '';
  renderComposer();
}

function setHudVisible(visible) {
  hudVisible = Boolean(visible);
  document.body.classList.toggle('hud-hidden', !hudVisible);
  trace('hud-state', { visible: hudVisible });
}

function clearSessionProjection() {
  // Explicit projection clearing also resets the installed-state marker: after
  // this, any rejected snapshot is a no-install (never classified keep-previous).
  hasInstalled = false;
  generation = '';
  lastSeq = -1;
  sessionStatus = 'unavailable';
  writeState = 'ready';
  authoritativeDraft = { revision: 0, text: '', locked: false };
  cursorWord = 0;
  seenSeqs.clear();
  core.resetConversation(conversation);
  $('session-id').textContent = '';
  $('proto').textContent = '';
  $('gen').textContent = '';
  $('asof').textContent = '';
  $('wsv').textContent = '';
  $('events').innerHTML = '';
  renderChat(true, 0);
  renderComposer();
  renderStatus();
}

function parseBridgeResult(raw) {
  try {
    const outer = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let body = outer?.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }
    return { status: Number(outer?.status) || 0, body: body };
  } catch (error) {
    return { status: 0, body: { ok: false, error: String(error) } };
  }
}

function nativeFetch(path, body) {
  try {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return parseBridgeResult(window.GlassesBridge.fetch(path, payload));
  } catch (error) {
    return { status: 0, body: { ok: false, error: String(error) } };
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
  loadPendingForConfiguredSession();
  trace('configuration-loaded', {
    endpoint: configuredEndpoint(),
    expectedSession: configuredSession(),
  });

  $('save').addEventListener('click', () => {
    const requestedBase = $('in-base').value.trim();
    const requestedSession = $('in-session').value.trim();
    stopTransport('reconfigure');
    clearIdentityFailure('save');
    clearSessionProjection();

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
    loadPendingForConfiguredSession();
    run();
  });

  // M1 is strictly read-only: the legacy SSE recovery path (onSseLine ->
  // recoverSnapshot -> applySnapshot) and stream state handling must have no
  // externally reachable effect. Publish bounded no-ops instead of wiring the
  // TB0 handlers.
  if (M1_READ_ONLY) {
    window.glassesOnLine = (eventName, data, id) => {
      trace('m1-sse-ignored', { event: eventName || null, id: id || null });
    };
    window.glassesOnStream = (state, detail) => {
      trace('m1-sse-ignored-stream', { state: String(state || ''), detail: detail || null });
    };
  } else {
    window.glassesOnLine = onSseLine;
    window.glassesOnStream = onStreamState;
  }
  window.glassesOnSemanticControl = handleSemanticControl;
  window.onNativeTrace = (line) => {
    $('tracebox').textContent = (line + '\n' + $('tracebox').textContent).slice(0, 7000);
  };

  // Backward-compatible G0 aid plus the C0 product-state view; neither exposes
  // the bearer token.
  window.g0DebugState = () => ({
    endpoint: configuredEndpoint(),
    expectedSession: configuredSession(),
    identityFailure: identityFailure ? { ...identityFailure } : null,
    streamOpen: streamOpen,
    streamVerified: streamVerified,
    generation: generation,
    lastSeq: lastSeq,
  });
  window.c0DebugState = () => ({
    ...window.g0DebugState(),
    mode: mode,
    hudVisible: hudVisible,
    installed: hasInstalled,
    wheel: { open: wheelOpen, selection: wheelSelection },
    sessionStatus: sessionStatus,
    writeState: writeState,
    draft: { ...authoritativeDraft, cursorWord: cursorWord },
    pendingMutation: pendingMutation?.body?.operationId || null,
    pendingSend: pendingSend?.body?.operationId || null,
    action: actionMessage,
    conversation: core.conversationItems(conversation).map((item) => ({ ...item })),
  });

  renderStatus();
  renderComposer();
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

  // M1 bootstrap: fetch raw -> stage (validate complete wire law + fence) ->
  // single atomic install. A rejected snapshot leaves the previous valid
  // screen untouched; with no prior install the session stays hidden.
  const accepted = stageAndInstall();
  if (!accepted) return;

  // M1 strictly read-only: no SSE auto-open, no pending-op resume.
}

// fetchSnapshot() is TRANSPORT-ONLY: it verifies an HTTP-200 object body and
// returns the RAW body. Every snapshot-data decision (session identity,
// unsupported major, malformed shape, generation...) belongs to stageSnapshot()
// so that a rejected snapshot can NEVER destructively clear an installed
// screen (no enterSessionMismatch/clearSessionProjection before staging).
function fetchSnapshot() {
  if (identityFailure) return null;
  const response = nativeFetch('/glasses/v1/bootstrap');
  if (response.status !== 200 || !response.body || typeof response.body !== 'object') {
    trace('bootstrap-failed', { status: response.status });
    if (!hasInstalled) {
      if (response.status === 401 || response.status === 403) {
        showProvision(true);
        showSession(false);
      }
    } else {
      trace('bootstrap-transport-failed-keep-previous', { status: response.status });
    }
    scheduleReconnect(response.status === 0 ? 'unreachable' : ('HTTP ' + response.status));
    return null;
  }
  return response.body;
}

// M1 fetch->stage->install entry. Pure staging is atomic by structure: a
// rejection discards the whole staged object and keeps the current screen.
function stageAndInstall() {
  if (identityFailure) return null;
  const raw = fetchSnapshot();
  if (!raw) return null;

  const judged = staging.stageSnapshot(raw, {
    expectedSessionId: configuredSession(),
  });
  if (!judged.ok) {
    if (hasInstalled) {
      setAction('Snapshot rejected · ' + judged.code, 'error');
      trace('snapshot-rejected-keep-previous', { code: judged.code, message: judged.message || '' });
    } else {
      trace('snapshot-rejected-no-install', { code: judged.code, message: judged.message || '' });
      setConn('off', 'snapshot-rejected');
    }
    scheduleReconnect('snapshot-rejected');
    return null;
  }

  installSnapshot(judged.snapshot);
  return judged.snapshot;
}

// installSnapshot() is the ONLY mutation of installed client state. It adopts
// the staged, fully-detached snapshot wholesale (generation, attachment
// identity, session state, history watermark, conversation, rendered chat,
// diagnostics). Nothing partial is revealed; the composer stays hidden.
function installSnapshot(staged) {
  if (identityFailure) return;
  const chat = $('chat');
  const preserveBottom = isNearBottom(chat);
  const previousTop = chat.scrollTop;

  generation = String(staged.serverGeneration || '');
  lastSeq = Number(staged.attachment.history.asOfSeq);
  if (!Number.isFinite(lastSeq)) lastSeq = -1;
  sessionStatus = String(staged.attachment.state || 'unavailable');
  writeState = String(staged.attachment.capabilities?.draftMutations ? 'enabled' : 'readonly');
  authoritativeDraft = { revision: 0, text: '', locked: false };
  cursorWord = 0;
  seenSeqs.clear();
  const events = staged.attachment.history.events || [];
  for (const event of events) {
    const seq = Number(event?.seq);
    if (Number.isFinite(seq)) seenSeqs.add(seq);
  }

  // Atomic adoption: the staged detached conversation becomes the live one.
  conversation = staged.conversation === undefined ? conversation : staged.conversation;
  hasInstalled = true;

  $('events').innerHTML = '';
  for (const event of events) addEventRow(event);
  $('session-id').textContent = String(staged.attachment.sessionId || '').slice(0, 12) + '…';
  $('proto').textContent = String(staged.protocolMajor ?? '');
  $('gen').textContent = generation.slice(0, 10);
  $('asof').textContent = String(lastSeq);
  $('wsv').textContent = writeState;

  showProvision(false);
  showIdentityError(false, '', '');
  showSession(true);
  renderChat(preserveBottom, previousTop);
  renderStatus();
  renderComposer();
  trace('snapshot-installed', {
    session: staged.attachment.sessionId,
    generation: generation,
    lastSeq: lastSeq,
    eventCount: events.length,
    messageCount: core.conversationItems(conversation).length,
    status: sessionStatus,
    writeState: writeState,
  });
}

function applySnapshot(snapshot) {
  if (identityFailure) return;
  const chat = $('chat');
  const preserveBottom = isNearBottom(chat);
  const previousTop = chat.scrollTop;

  generation = String(snapshot.serverGeneration || '');
  lastSeq = Number(snapshot.history?.asOfSeq);
  if (!Number.isFinite(lastSeq)) lastSeq = -1;
  sessionStatus = String(snapshot.attachment?.status || 'unavailable');
  writeState = String(snapshot.writeState || 'ready');
  authoritativeDraft = {
    revision: Number(snapshot.draft?.revision) || 0,
    text: String(snapshot.draft?.text || ''),
    locked: Boolean(snapshot.draft?.locked),
  };
  cursorWord = core.clampCursor(authoritativeDraft.text, cursorWord);

  seenSeqs.clear();
  core.resetConversation(conversation);
  $('events').innerHTML = '';

  const events = Array.isArray(snapshot.history?.events)
    ? [...snapshot.history.events].sort((a, b) => Number(a.seq) - Number(b.seq))
    : [];
  for (const event of events) {
    const seq = Number(event.seq);
    if (Number.isFinite(seq)) seenSeqs.add(seq);
    core.applyConversationEvent(conversation, event);
    addEventRow(event);
  }

  $('session-id').textContent = String(snapshot.attachment.sessionId).slice(0, 12) + '…';
  $('proto').textContent = String(snapshot.protocolMajor ?? '');
  $('gen').textContent = generation.slice(0, 10);
  $('asof').textContent = String(lastSeq);
  $('wsv').textContent = writeState;

  renderChat(preserveBottom, previousTop);
  renderStatus();
  renderComposer();
  trace('bootstrap-applied', {
    session: snapshot.attachment.sessionId,
    generation: generation,
    asOfSeq: lastSeq,
    eventCount: events.length,
    messageCount: core.conversationItems(conversation).length,
    status: sessionStatus,
    writeState: writeState,
    draftRevision: authoritativeDraft.revision,
    draftLocked: authoritativeDraft.locked,
  });

  setTimeout(resumePendingOperations, 0);
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

function onSseLine(eventName, data, id) {
  if (identityFailure) {
    trace('sse-ignored-identity-failure', { event: eventName || null, id: id || null });
    return;
  }

  let decoded = data;
  try { decoded = JSON.parse(data); } catch (_) {}

  if (eventName === 'hello') {
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
    recoverSnapshot('stream-open');
    return;
  }

  if (!streamVerified) {
    trace('sse-event-before-identity', { event: eventName || null, id: id || null });
    return;
  }

  if (eventName === 'gap') {
    trace('sse-gap', decoded);
    recoverSnapshot('server-gap');
    return;
  }
  if (eventName !== 'projection' || !decoded || typeof decoded !== 'object') {
    renderRaw(eventName, id);
    return;
  }

  if (decoded.generation && generation && decoded.generation !== generation) {
    trace('projection-generation-mismatch', { expected: generation, actual: decoded.generation, seq: decoded.seq });
    recoverSnapshot('projection-generation-change');
    return;
  }

  const seq = Number(decoded.seq);
  if (!Number.isFinite(seq)) {
    trace('projection-invalid-seq', { id: id || null, type: decoded.type || null });
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
  applyLiveProjection(decoded);
}

function onStreamState(state, detail) {
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
}

function applyLiveProjection(event) {
  const seq = Number(event.seq);
  seenSeqs.add(seq);
  lastSeq = Math.max(lastSeq, seq);
  $('asof').textContent = String(lastSeq);

  if (event.type === 'turn/start' || event.type === 'step/start') sessionStatus = 'running';
  if (event.type === 'turn/end') sessionStatus = 'idle';

  const changed = core.applyConversationEvent(conversation, event);
  if (changed) renderChat(false);
  addEventRow(event);
  renderStatus();
  trace('projection-applied', {
    seq: seq,
    type: event.type || '',
    conversationChanged: changed,
  });

  if (
    pendingSend &&
    event.type === 'user/message' &&
    event.message?.rpcId === pendingSend.body.operationId
  ) {
    scheduleSendRetry(0);
  }
}

function renderStatus() {
  $('session-state').textContent = sessionStatus;
  $('mode').textContent = mode === 'input' ? 'INPUT' : 'NAV';
  $('wsv').textContent = writeState;
  document.body.classList.toggle('hud-hidden', !hudVisible);
}

function isNearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 28;
}

function renderChat(forceBottom, preservedTop) {
  const chat = $('chat');
  const shouldStick = Boolean(forceBottom) || isNearBottom(chat);
  const oldTop = Number.isFinite(preservedTop) ? preservedTop : chat.scrollTop;
  const items = core.conversationItems(conversation);
  chat.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat';
    empty.textContent = 'No projected text messages yet.';
    chat.appendChild(empty);
  } else {
    for (const item of items) {
      const article = document.createElement('article');
      article.className = 'message ' + item.role + (item.partial ? ' partial' : '');
      article.dataset.seq = String(item.seq);
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = item.role === 'user'
        ? 'you'
        : (item.partial ? 'assistant · streaming' : 'assistant');
      const body = document.createElement('span');
      body.className = 'body';
      body.textContent = item.text;
      article.append(role, body);
      chat.appendChild(article);
    }
  }

  if (shouldStick) chat.scrollTop = chat.scrollHeight;
  else chat.scrollTop = oldTop;
}

function renderComposer() {
  const composer = $('composer');
  composer.classList.toggle('hidden', mode !== 'input');
  if (mode !== 'input') return;

  cursorWord = core.clampCursor(authoritativeDraft.text, cursorWord);
  $('draft-meta').textContent =
    'rev ' + authoritativeDraft.revision +
    (authoritativeDraft.locked ? ' · locked' : '') +
    ' · ' + writeState;

  const node = $('draft-text');
  node.innerHTML = '';
  const ranges = core.wordRanges(authoritativeDraft.text);
  if (cursorWord < ranges.length) {
    const range = ranges[cursorWord];
    node.appendChild(document.createTextNode(authoritativeDraft.text.slice(0, range.start)));
    const cursor = document.createElement('span');
    cursor.className = 'cursor-word';
    cursor.textContent = authoritativeDraft.text.slice(range.start, range.end);
    node.appendChild(cursor);
    node.appendChild(document.createTextNode(authoritativeDraft.text.slice(range.end)));
  } else {
    node.appendChild(document.createTextNode(authoritativeDraft.text));
    const cursor = document.createElement('span');
    cursor.className = 'cursor-end';
    cursor.setAttribute('aria-label', 'end cursor');
    node.appendChild(cursor);
  }

  const action = $('action-state');
  action.className = actionTone === 'error'
    ? 'error-state'
    : (wheelOpen ? 'wheel-state' : '');
  if (wheelOpen) {
    action.textContent = wheelSelection === 'send'
      ? 'wheel · SEND selected · release COMMAND'
      : 'wheel · DOWN selects SEND · release cancels';
  } else {
    action.textContent = actionMessage || 'SECONDARY=paste · long COMMAND, DOWN, release=Send';
  }
}

function addEventRow(event) {
  const li = document.createElement('li');
  li.className = 'ev';
  li.textContent = '#' + (event.seq != null ? event.seq : '?') + ' ' + (event.type || '');
  if (event.seq != null) li.setAttribute('data-seq', event.seq);
  $('events').prepend(li);
  while ($('events').children.length > 100) $('events').removeChild($('events').lastChild);
}

function renderRaw(eventName, id) {
  if (!eventName || eventName === 'message' || identityFailure) return;
  const li = document.createElement('li');
  li.className = 'ev';
  li.textContent = eventName + (id ? ' #' + id : '');
  $('events').prepend(li);
  trace('sse-raw', { event: eventName, id: id || null });
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

function normalizeSemanticName(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function handleSemanticControl(rawName, source) {
  const name = normalizeSemanticName(rawName);
  const provenance = String(source || 'UNKNOWN');
  if (!name) return;
  trace('semantic-control', {
    name: name,
    source: provenance,
    mode: mode,
    hudVisible: hudVisible,
    wheelOpen: wheelOpen,
  });

  // M1 (#27) is strictly read-only: the composer never opens, no paste, no
  // Send, no wheel. Only HUD wake/hide remain meaningful; every other control
  // is informational. The classic branch below is dormant TB0 code.
  if (M1_READ_ONLY) {
    if (!hudVisible) {
      setHudVisible(true);
      setAction('HUD awake · M1 is read-only', '');
      trace('hud-wake-only', { name: name, source: provenance });
      return;
    }
    switch (name) {
      case 'SECONDARY_DOUBLE':
      case 'HUD_HIDE':
        setHudVisible(false);
        return;
      case 'COMMAND':
      case 'COMMAND_SHORT':
      case 'COMMAND_LONG':
      case 'DOWN':
      case 'COMMAND_RELEASE':
      case 'RIGHT':
      case 'LEFT':
      case 'SECONDARY':
      case 'SECONDARY_SHORT':
      case 'PASTE':
      case 'SEND':
      case 'ACTION_SEND':
        setAction('M1 is read-only', '');
        return;
      default:
        setAction('Control deferred in C0: ' + name, '');
        trace('semantic-control-deferred', { name: name, source: provenance });
    }
    return;
  }

  // Frozen TB0 hidden-HUD rule: the first recognized operation only wakes.
  if (!hudVisible) {
    setHudVisible(true);
    setAction('HUD awake · operation consumed', '');
    trace('hud-wake-only', { name: name, source: provenance });
    return;
  }

  switch (name) {
    case 'COMMAND':
    case 'COMMAND_SHORT':
      wheelOpen = false;
      wheelSelection = null;
      mode = mode === 'navigation' ? 'input' : 'navigation';
      setAction(mode === 'input' ? 'Input mode' : 'Navigation mode', '');
      renderStatus();
      renderComposer();
      return;

    case 'COMMAND_LONG':
      if (mode !== 'input') {
        setAction('Navigation head-anchor behavior is outside C0', '');
        return;
      }
      wheelOpen = true;
      wheelSelection = null;
      renderComposer();
      return;

    case 'DOWN':
      if (wheelOpen) {
        wheelSelection = 'send';
        renderComposer();
      } else {
        setAction('HUD-line motion is outside C0', '');
      }
      return;

    case 'COMMAND_RELEASE':
      if (!wheelOpen) return;
      const selected = wheelSelection;
      wheelOpen = false;
      wheelSelection = null;
      renderComposer();
      if (selected === 'send') startSend();
      else setAction('Wheel canceled', '');
      return;

    case 'RIGHT':
      if (mode === 'input' && !wheelOpen) {
        cursorWord = core.moveCursor(authoritativeDraft.text, cursorWord, 'right');
        renderComposer();
      } else {
        setAction('Navigation word motion is outside C0', '');
      }
      return;

    case 'LEFT':
      if (mode === 'input' && !wheelOpen) {
        cursorWord = core.moveCursor(authoritativeDraft.text, cursorWord, 'left');
        renderComposer();
      } else {
        setAction('Navigation word motion is outside C0', '');
      }
      return;

    case 'SECONDARY':
    case 'SECONDARY_SHORT':
    case 'PASTE':
      if (mode !== 'input' || wheelOpen) {
        setAction('Paste requires ordinary Input mode', 'error');
        return;
      }
      pasteClipboard();
      return;

    case 'SECONDARY_DOUBLE':
    case 'HUD_HIDE':
      wheelOpen = false;
      wheelSelection = null;
      setHudVisible(false);
      return;

    case 'SEND':
    case 'ACTION_SEND':
      startSend();
      return;

    default:
      setAction('Control deferred in C0: ' + name, '');
      trace('semantic-control-deferred', { name: name, source: provenance });
  }
}

function readClipboardText() {
  try { return String(window.GlassesBridge.clipboardText() || ''); }
  catch (_) { return ''; }
}

function pasteClipboard() {
  if (pendingMutation || mutationInFlight) {
    setAction('Draft mutation already pending', 'error');
    return;
  }
  if (pendingSend || authoritativeDraft.locked || writeState !== 'ready') {
    setAction('Draft is locked or reconciling', 'error');
    return;
  }

  const result = core.insertClipboard(authoritativeDraft.text, cursorWord, readClipboardText());
  if (!result.changed) {
    setAction('Clipboard is empty', '');
    return;
  }

  const body = {
    operationId: newOperationId('c0-mut'),
    expectedRevision: authoritativeDraft.revision,
    mutation: { kind: 'replace', text: result.text },
  };
  pendingMutation = {
    sessionId: configuredSession(),
    body: body,
    targetText: result.text,
    targetCursorWord: result.cursorWord,
    attempts: 0,
  };
  persistPendingMutation();
  setAction('Pasting · ' + body.operationId.slice(0, 18) + '…', '');
  performPendingMutation();
}

function performPendingMutation() {
  cancelMutationRetry();
  if (!pendingMutation || mutationInFlight) return;
  if (pendingMutation.sessionId !== configuredSession()) return;
  mutationInFlight = true;
  const record = pendingMutation;
  trace('mutation-attempt', {
    operationId: record.body.operationId,
    expectedRevision: record.body.expectedRevision,
    attempt: record.attempts || 0,
  });

  const response = nativeFetch('/glasses/v1/draft/mutations', record.body);
  mutationInFlight = false;

  if (response.status === 200 && response.body?.ok) {
    const revision = Number(response.body.revision);
    clearPendingMutation();
    authoritativeDraft = {
      revision: Number.isFinite(revision) ? revision : authoritativeDraft.revision + 1,
      text: record.targetText,
      locked: false,
    };
    cursorWord = core.clampCursor(record.targetText, record.targetCursorWord);
    setAction('Draft committed', '');
    trace('mutation-accepted', { operationId: record.body.operationId, revision: authoritativeDraft.revision });
    recoverSnapshot('draft-mutation');
    return;
  }

  if (response.status === 409 || response.status === 400) {
    const error = response.body?.error || ('HTTP ' + response.status);
    clearPendingMutation();
    setAction('Paste rejected · ' + error, 'error');
    trace('mutation-rejected', { operationId: record.body.operationId, status: response.status, error: error });
    recoverSnapshot('draft-mutation-conflict');
    return;
  }

  record.attempts = (record.attempts || 0) + 1;
  pendingMutation = record;
  persistPendingMutation();
  setAction('Paste pending · retry ' + record.attempts, '');
  scheduleMutationRetry();
}

function scheduleMutationRetry(delayMs) {
  if (!pendingMutation || mutationRetryTimer !== null) return;
  const delay = delayMs ?? Math.min(8_000, 750 * Math.pow(2, Math.min(4, pendingMutation.attempts || 0)));
  mutationRetryTimer = setTimeout(() => {
    mutationRetryTimer = null;
    performPendingMutation();
  }, delay);
}

function cancelMutationRetry() {
  if (mutationRetryTimer !== null) clearTimeout(mutationRetryTimer);
  mutationRetryTimer = null;
}

function startSend() {
  if (pendingMutation || mutationInFlight) {
    setAction('Wait for the draft mutation', 'error');
    return;
  }
  if (pendingSend) {
    setAction('Resuming existing Send', '');
    performPendingSend();
    return;
  }
  if (mode !== 'input') {
    setAction('Send requires Input mode', 'error');
    return;
  }
  if (sessionStatus === 'running') {
    setAction('Session is running; Steer/Interrupt are outside TB0', 'error');
    return;
  }
  if (writeState !== 'ready' || authoritativeDraft.locked) {
    setAction('Send blocked while write state reconciles', 'error');
    return;
  }
  if (!authoritativeDraft.text.trim()) {
    setAction('Draft is empty', '');
    return;
  }

  const body = {
    kind: 'send',
    operationId: newOperationId('c0-send'),
    draftRevision: authoritativeDraft.revision,
  };
  pendingSend = {
    sessionId: configuredSession(),
    body: body,
    attempts: 0,
    halted: false,
  };
  persistPendingSend();
  setAction('Sending · ' + body.operationId.slice(0, 18) + '…', '');
  performPendingSend();
}

function performPendingSend() {
  cancelSendRetry();
  if (!pendingSend || sendInFlight || pendingSend.halted) return;
  if (pendingSend.sessionId !== configuredSession()) return;
  sendInFlight = true;
  const record = pendingSend;
  trace('send-attempt', {
    operationId: record.body.operationId,
    draftRevision: record.body.draftRevision,
    attempt: record.attempts || 0,
  });

  const response = nativeFetch('/glasses/v1/actions', record.body);
  sendInFlight = false;
  const state = String(response.body?.state || '');

  if ((response.status === 200 || response.status === 202) && state === 'accepted') {
    clearPendingSend();
    wheelOpen = false;
    wheelSelection = null;
    mode = 'navigation';
    setAction('Send accepted', '');
    renderStatus();
    renderComposer();
    trace('send-accepted', { operationId: record.body.operationId, status: response.status });
    recoverSnapshot('send-accepted');
    return;
  }

  if ((response.status === 200 || response.status === 202) && state === 'rejected') {
    clearPendingSend();
    setAction('Send rejected', 'error');
    trace('send-rejected', { operationId: record.body.operationId });
    recoverSnapshot('send-rejected');
    return;
  }

  if (
    (response.status === 200 || response.status === 202) &&
    ['prepared', 'dispatching', 'unknown'].includes(state)
  ) {
    record.attempts = (record.attempts || 0) + 1;
    pendingSend = record;
    persistPendingSend();
    setAction('Send ' + state + ' · same-ID poll ' + record.attempts, '');
    scheduleSendRetry();
    return;
  }

  if (response.status === 409 || response.status === 400) {
    const error = response.body?.error || ('HTTP ' + response.status);
    clearPendingSend();
    setAction('Send conflict · ' + error, 'error');
    trace('send-conflict', { operationId: record.body.operationId, status: response.status, error: error });
    recoverSnapshot('send-conflict');
    return;
  }

  if (response.status === 500 && response.body?.error === 'identity-invariant-failure') {
    record.halted = true;
    pendingSend = record;
    persistPendingSend();
    setAction('Send halted · identity invariant failure', 'error');
    trace('send-invariant-failure', { operationId: record.body.operationId });
    return;
  }

  record.attempts = (record.attempts || 0) + 1;
  pendingSend = record;
  persistPendingSend();
  setAction('Send response unknown · same-ID retry ' + record.attempts, '');
  scheduleSendRetry();
}

function scheduleSendRetry(delayMs) {
  if (!pendingSend || pendingSend.halted) return;
  if (sendRetryTimer !== null) {
    if (delayMs === 0) {
      clearTimeout(sendRetryTimer);
      sendRetryTimer = null;
    } else {
      return;
    }
  }
  const delay = delayMs ?? Math.min(5_000, 750 * Math.pow(2, Math.min(3, pendingSend.attempts || 0)));
  sendRetryTimer = setTimeout(() => {
    sendRetryTimer = null;
    performPendingSend();
  }, delay);
}

function cancelSendRetry() {
  if (sendRetryTimer !== null) clearTimeout(sendRetryTimer);
  sendRetryTimer = null;
}

function resumePendingOperations() {
  if (identityFailure || !configuredSession()) return;
  if (pendingMutation) {
    setAction('Recovering pending draft mutation', '');
    scheduleMutationRetry(0);
    return;
  }
  if (pendingSend) {
    setAction(pendingSend.halted ? 'Send halted; inspect diagnostics' : 'Recovering pending Send', pendingSend.halted ? 'error' : '');
    if (!pendingSend.halted) scheduleSendRetry(0);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
