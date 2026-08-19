/* G0 WebView logic: bootstrap fetch (native-authenticated), SSE, one-session
 * projection, reconnect via bootstrap-first recovery. No Send, no draft. */
'use strict';

const $ = (id) => document.getElementById(id);
let streamOpen = false;

function showProvision(show) { $('provision').classList.toggle('hidden', !show); }
function setConn(state, text) {
  const dot = $('conn');
  dot.className = 'dot ' + (state === 'open' ? 'on' : state === 'reconnecting' ? 'mid' : 'off');
  dot.textContent = text;
}

function init() {
  $('save').addEventListener('click', () => {
    window.GlassesBridge.configure($('in-base').value, $('in-token').value, $('in-session').value);
    $('in-token').value = '';
    run();
  });
  window.glassesOnLine = (event, data) => {
    try { const d = JSON.parse(data); renderEvent(event, d); } catch (e) { renderEvent(event, data); }
  };
  window.glassesOnStream = (state, detail) => {
    if (state === 'open') { streamOpen = true; setConn('open', 'live'); }
    else if (state === 'closed') { streamOpen = false; setConn('reconnecting', 'closed·reconnect'); }
    else { streamOpen = false; setConn('off', 'offline'); setTimeout(reconnect, 3000); }
  };
  window.onNativeTrace = (line) => {
    $('tracebox').textContent = (line + '\n' + $('tracebox').textContent).slice(0, 4000);
  };
  run();
}

function run() {
  const resp = JSON.parse(window.GlassesBridge.fetch('/glasses/v1/bootstrap', ''));
  if (resp.status !== 200) { showProvision(true); setConn('off', 'auth'); return; }
  showProvision(false);
  const d = JSON.parse(resp.body);
  $('session-id').textContent = d.attachment.sessionId.slice(0, 12) + '…';
  $('proto').textContent = d.protocolMajor;
  $('gen').textContent = d.serverGeneration.slice(0, 10);
  $('asof').textContent = d.history.asOfSeq;
  $('status').textContent = d.attachment.status;
  $('wsv').textContent = d.writeState || '-';
  $('events').innerHTML = '';
  (d.history.events || []).slice(-30).forEach((e) => renderEvent(e.type, e));
  if (streamOpen) return;
  streamOpen = true;
  window.GlassesBridge.openStream();
}

function renderEvent(event, d) {
  if (event === 'projection') {
    const li = document.createElement('li');
    li.className = 'ev';
    li.textContent = '#' + (d.seq != null ? d.seq : '?') + ' ' + (d.type || '');
    li.setAttribute('data-seq', d.seq);
    $('events').prepend(li);
    if ($('events').children.length > 100) $('events').removeChild($('events').lastChild);
  } else if (event !== 'hello') {
    const li = document.createElement('li'); li.className = 'ev raw'; li.textContent = event + ' ' + JSON.stringify(d); $('events').prepend(li);
  }
}

function reconnect() {
  const resp = JSON.parse(window.GlassesBridge.fetch('/glasses/v1/bootstrap', ''));
  if (resp.status === 200) run(); else setTimeout(reconnect, 3000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
