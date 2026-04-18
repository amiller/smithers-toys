// The Vite ESM bundle exports via window.MatrixSDK
import './matrix-sdk.esm.js';

// Wait for the module to set window.MatrixSDK
const sdk = window.MatrixSDK || await new Promise((resolve) => {
  let checks = 0;
  const interval = setInterval(() => {
    if (window.MatrixSDK) { clearInterval(interval); resolve(window.MatrixSDK); }
    if (++checks > 50) { clearInterval(interval); resolve(null); }
  }, 100);
});

const HOMESERVER_KEY = 'smithers_dash_hs';
const ROOM_KEY = 'smithers_dash_room';
const TOKEN_KEY = 'smithers_dash_token';

const hsInput = document.getElementById('homeserver');
const roomInput = document.getElementById('roomId');
const tokenInput = document.getElementById('accessToken');

// Parse config from URL hash: #hs=...&room=...&token=...
function parseHash() {
  const hash = location.hash.slice(1);
  if (!hash) return {};
  const params = {};
  for (const part of hash.split('&')) {
    const [k, v] = part.split('=');
    if (k && v) params[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return params;
}

const hashConfig = parseHash();
if (hashConfig.hs) localStorage.setItem(HOMESERVER_KEY, hashConfig.hs);
if (hashConfig.room) localStorage.setItem(ROOM_KEY, hashConfig.room);
if (hashConfig.token) localStorage.setItem(TOKEN_KEY, hashConfig.token);

// Clear the hash from the URL so the token isn't visible in history/address bar
if (Object.keys(hashConfig).length > 0) {
  history.replaceState(null, '', location.pathname);
}

hsInput.value = localStorage.getItem(HOMESERVER_KEY) || '';
roomInput.value = localStorage.getItem(ROOM_KEY) || '';
tokenInput.value = localStorage.getItem(TOKEN_KEY) || '';

let client = null;
let connectedAt = null;
let uptimeInterval = null;
let telemetryInterval = null;
let msgCount = 0;
let currentRoomId = null;
let lastStructuredData = null;
let lastTelemetryTs = 0;

const TELEMETRY_INTERVAL_MS = 30000; // auto-refresh every 30s while visible

async function requestTelemetry() {
  if (!client || !currentRoomId) return;
  const txnId = 'cmd-' + Date.now();
  try {
    await client.sendEvent(currentRoomId, 'm.room.message', {
      msgtype: 'm.text',
      body: '!telemetry',
    }, txnId);
    console.log('Sent !telemetry command');
  } catch (err) {
    console.error('Failed to send !telemetry:', err);
  }
}
window.requestTelemetry = requestTelemetry;

function startTelemetryPoll() {
  stopTelemetryPoll();
  requestTelemetry();
  telemetryInterval = setInterval(() => {
    if (!document.hidden) requestTelemetry();
  }, TELEMETRY_INTERVAL_MS);
}

function stopTelemetryPoll() {
  if (telemetryInterval) { clearInterval(telemetryInterval); telemetryInterval = null; }
}

function setStatus(state, text) {
  document.getElementById('statusDot').className = 'status-dot ' + state;
  document.getElementById('statusText').textContent = text;
}

function showError(msg) {
  const b = document.getElementById('errorBanner');
  b.textContent = msg;
  b.style.display = 'block';
  setTimeout(() => { b.style.display = 'none'; }, 8000);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function parseTelemetry(body) {
  const result = {};
  const parts = body.split(' | ');
  for (const p of parts) {
    const kv = p.trim().match(/^(\w[\w\s]*?):\s*(.+)$/);
    if (kv) {
      result[kv[1].trim().toLowerCase().replace(/\s+/g, '_')] = kv[2].trim();
    }
  }
  return result;
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return '--';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function updateStatCards(body) {
  if (!body.includes('CVM Telemetry')) return;
  const t = parseTelemetry(body);
  if (t.cpu) document.getElementById('cpuVal').textContent = t.cpu;
  if (t.mem) document.getElementById('memVal').textContent = t.mem.split('(')[0].trim();
  if (t.disk) document.getElementById('diskVal').textContent = t.disk;
}

function updateProcessTable(processes) {
  const tbody = document.getElementById('procBody');
  if (!tbody || !processes || !processes.length) return;
  tbody.innerHTML = processes.map(p => {
    const cmdline = p.cmdline ? `<span class="proc-cmdline" title="${escapeHtml(p.cmdline)}">${escapeHtml(p.cmdline)}</span>` : '';
    return `<tr>
      <td>${escapeHtml(String(p.pid))}</td>
      <td>
        <span class="proc-name">${escapeHtml(p.name)}</span>
        ${cmdline}
      </td>
      <td>${p.rss_mb.toFixed ? p.rss_mb.toFixed(0) : p.rss_mb} MB</td>
    </tr>`;
  }).join('');
  document.getElementById('procCount').textContent = processes.length;
}

function updateSmithersPanel(smithers) {
  const panel = document.getElementById('smithersPanel');
  if (!panel || !smithers || !smithers.length) return;

  for (const ws of smithers) {
    if (ws.error) continue;
    const runs = ws.runs || [];
    const nodes = ws.nodes || [];
    if (!runs.length) continue;

    const latest = runs[0];
    const isRunning = latest.status === 'running';

    // Find the actively running node
    const activeNode = nodes.find(n => n.is_live) || nodes.find(n => n.state === 'in-progress') || null;
    const activeInfo = activeNode ? buildActiveTaskHtml(activeNode) : '';

    const runEl = document.getElementById('smithersRun') || document.createElement('div');
    runEl.id = 'smithersRun';
    runEl.className = 'smithers-run';
    runEl.innerHTML = `
      <div class="smithers-run-header">
        <span class="smithers-workflow">${escapeHtml(latest.workflow)}</span>
        <span class="status-badge ${isRunning ? 'running' : latest.status === 'failed' ? 'failed' : 'complete'}">${escapeHtml(latest.status)}</span>
        <span class="smithers-runtime">${formatDuration(latest.runtime_sec)}</span>
        <span class="smithers-run-id">${escapeHtml(latest.run_id.slice(-6))}</span>
      </div>
      ${activeInfo}
      <div class="smithers-nodes">
        ${nodes.map(n => {
          const isLive = n.is_live;
          const stateClass = n.state === 'finished' ? 'complete' :
                             n.state === 'in-progress' || isLive ? 'running' :
                             n.state === 'failed' ? 'failed' : 'pending';
          const elapsed = n.elapsed_sec ? formatDuration(n.elapsed_sec) : '';
          const errorTag = n.error ? `<span class="node-error">${escapeHtml(n.error)}</span>` : '';
          const liveDot = isLive ? '<span class="live-dot"></span>' : '';
          return `<div class="smithers-node ${stateClass}">
            ${liveDot}
            <span class="node-id">${escapeHtml(n.id)}</span>
            <span class="status-badge ${stateClass}">${escapeHtml(isLive ? 'live' : n.state)}</span>
            ${elapsed ? `<span class="node-elapsed">${elapsed}</span>` : ''}
            ${errorTag}
          </div>`;
        }).join('')}
      </div>
    `;
    if (!document.getElementById('smithersRun')) {
      panel.appendChild(runEl);
    }
  }
  panel.style.display = '';
}

function buildActiveTaskHtml(node) {
  let details = [];
  if (node.editing) {
    details.push(`<div class="active-detail"><span class="active-label">editing</span> <code>${escapeHtml(node.editing.split('/').slice(-2).join('/'))}</code></div>`);
  }
  if (node.thinking) {
    details.push(`<div class="active-detail"><span class="active-label">thinking</span> ${escapeHtml(node.thinking)}</div>`);
  }
  if (node.last_action) {
    details.push(`<div class="active-detail"><span class="active-label">action</span> ${escapeHtml(node.last_action)}</div>`);
  }
  if (node.last_output && !node.thinking) {
    details.push(`<div class="active-detail"><span class="active-label">output</span> ${escapeHtml(node.last_output)}</div>`);
  }

  if (!details.length) return '';

  return `<div class="active-task">
    <div class="active-task-header">
      <span class="live-dot"></span>
      <span class="active-task-name">${escapeHtml(node.id)}</span>
      ${node.stale_sec != null ? `<span class="active-task-age">${node.stale_sec < 5 ? 'now' : node.stale_sec + 's ago'}</span>` : ''}
    </div>
    ${details.join('')}
  </div>`;
}

function handleStructuredTelemetry(data) {
  if (!data || data.type !== 'cvm_telemetry') return;
  lastStructuredData = data;
  lastTelemetryTs = Date.now();

  // Flash the update indicator
  const indicator = document.getElementById('updateFlash');
  if (indicator) {
    indicator.classList.remove('flash');
    void indicator.offsetWidth; // reflow
    indicator.classList.add('flash');
  }

  // Update stat cards from structured data
  const s = data.system;
  document.getElementById('cpuVal').textContent = s.cpu_pct + '%';
  document.getElementById('memVal').textContent = `${Math.round(s.mem_total_mb - s.mem_available_mb)}/${Math.round(s.mem_total_mb)} MB`;
  document.getElementById('diskVal').textContent = `${s.disk_used}/${s.disk_total}`;
  document.getElementById('loadVal').textContent = s.load_1m;

  // Update process table
  updateProcessTable(data.processes);

  // Update smithers panel
  updateSmithersPanel(data.smithers);

  // Start countdown to next update
  startCountdown();
}

function startCountdown() {
  const el = document.getElementById('nextUpdate');
  if (!el) return;
  const target = Date.now() + TELEMETRY_INTERVAL_MS;
  if (window._countdownInterval) clearInterval(window._countdownInterval);
  window._countdownInterval = setInterval(() => {
    const remaining = Math.max(0, Math.round((target - Date.now()) / 1000));
    el.textContent = remaining + 's';
    if (remaining <= 0) clearInterval(window._countdownInterval);
  }, 1000);
}

function buildMessageHtml(event) {
  const content = event.getContent ? event.getContent() : event.content;
  if (!content || !content.body) return null;

  const isTelemetry = content.body.includes('CVM Telemetry');
  const isTelemetryRequest = content.body.trim() === '!telemetry';
  if (isTelemetryRequest) return null;

  // Try to parse structured telemetry from formatted_body
  if (isTelemetry && content.format === 'org.matrix.custom.html' && content.formatted_body) {
    try {
      const data = JSON.parse(content.formatted_body);
      handleStructuredTelemetry(data);
    } catch (e) {
      // Not valid JSON, fall through to plain text parsing
    }
  }

  const sender = (event.getSender ? event.getSender() : event.sender) || 'unknown';
  const ts = (event.getDate ? event.getDate() : null) ||
             (event.origin_server_ts ? new Date(event.origin_server_ts) : new Date());
  const timeStr = ts.toLocaleTimeString();

  let bodyHtml = escapeHtml(content.body);
  let badges = '';

  const statusMatch = content.body.match(/\[Status:\s*(\w+)\]/i) ||
                      content.body.match(/Status:\s*(\w+)/i);
  if (statusMatch) {
    const st = statusMatch[1].toLowerCase();
    const cls = ['completed','success'].includes(st) ? 'complete' :
                ['failed','error'].includes(st) ? 'failed' :
                st === 'running' ? 'running' : 'pending';
    if (['running','complete','completed','success','failed','error','pending','waiting'].includes(st)) {
      badges = `<span class="status-badge ${cls}">${escapeHtml(st)}</span> `;
    }
  }

  bodyHtml = bodyHtml.replace(/\n/g, '<br>').replace(/`([^`]+)`/g, '<code>$1</code>');

  let telemHtml = '';
  if (isTelemetry) {
    // Telemetry card is now rendered by handleStructuredTelemetry into the panels.
    // The message feed card just shows a minimal summary.
    telemHtml = '<div class="telem-updated">updated above</div>';
  }

  return {
    isTelemetry,
    className: 'message-card' + (isTelemetry ? ' telemetry' : ''),
    innerHTML:
      `<div class="meta">
        <span class="sender">${escapeHtml(sender)}</span>
        ${badges}
        <span class="time">${timeStr}</span>
      </div>
      <div class="body">${bodyHtml}</div>
      ${telemHtml}`
  };
}

function renderMessage(event) {
  const content = event.getContent ? event.getContent() : event.content;
  if (!content || !content.body) return;

  msgCount++;
  document.getElementById('msgCount').textContent = msgCount;
  document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

  updateStatCards(content.body);

  const empty = document.getElementById('emptyState');
  if (empty) empty.remove();

  const parsed = buildMessageHtml(event);
  if (!parsed) return;

  const feed = document.getElementById('feed');

  if (parsed.isTelemetry) {
    let card = document.getElementById('telemetryLive');
    if (!card) {
      card = document.createElement('div');
      card.id = 'telemetryLive';
      feed.insertBefore(card, feed.firstChild);
    }
    card.className = parsed.className;
    card.innerHTML = parsed.innerHTML;
  } else {
    const card = document.createElement('div');
    card.className = parsed.className;
    card.innerHTML = parsed.innerHTML;
    feed.insertBefore(card, feed.firstChild);
    const cards = feed.querySelectorAll('.message-card:not(#telemetryLive)');
    for (let i = 20; i < cards.length; i++) cards[i].remove();
  }
}

function startUptimeCounter() {
  if (uptimeInterval) clearInterval(uptimeInterval);
  uptimeInterval = setInterval(() => {
    if (!connectedAt) return;
    const elapsed = Date.now() - connectedAt;
    const mins = Math.floor(elapsed / 60000);
    const hrs = Math.floor(mins / 60);
    const secs = Math.floor(elapsed / 1000) % 60;
    document.getElementById('uptime').textContent =
      hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${secs}s`;
  }, 1000);
}

async function connect() {
  const hs = hsInput.value.trim();
  const room = roomInput.value.trim();
  const token = tokenInput.value.trim();

  if (!hs || !room || !token) {
    showError('All three fields are required.');
    return;
  }

  localStorage.setItem(HOMESERVER_KEY, hs);
  localStorage.setItem(ROOM_KEY, room);
  localStorage.setItem(TOKEN_KEY, token);

  if (client) { client.stopClient(); client = null; }
  stopTelemetryPoll();
  currentRoomId = room;

  setStatus('connecting', 'Connecting...');
  showError('');

  try {
    const whoamiResp = await fetch(hs + '/_matrix/client/v3/account/whoami', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const whoami = await whoamiResp.json();
    const userId = whoami.user_id;
    if (!userId) throw new Error('Invalid token: ' + JSON.stringify(whoami));
    console.log('Authenticated as:', userId);

    const deviceId = whoami.device_id || 'SMITHERS_DASH_' + userId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);

    client = sdk.createClient({
      baseUrl: hs,
      accessToken: token,
      userId: userId,
      deviceId: deviceId,
    });

    try {
      if (typeof client.initRustCrypto === 'function') {
        await client.initRustCrypto();
        console.log('E2EE crypto initialized');
        document.getElementById('lockIcon').className = 'lock locked';
        document.getElementById('lockIcon').innerHTML = '&#128274;';
      } else {
        console.warn('initRustCrypto not available');
        document.getElementById('lockIcon').className = 'lock unlocked';
        document.getElementById('lockIcon').innerHTML = '&#128275;';
      }
    } catch (cryptoErr) {
      console.warn('Crypto init failed:', cryptoErr);
      document.getElementById('lockIcon').className = 'lock unlocked';
      document.getElementById('lockIcon').innerHTML = '&#128275;';
    }

    await client.startClient({ initialSyncLimit: 30 });

    client.on('sync', (state, prevState, data) => {
      if (state === 'PREPARED') {
        setStatus('connected', 'Connected');
        connectedAt = Date.now();
        startUptimeCounter();
        const roomObj = client.getRoom(room);
        if (roomObj) {
          roomObj.getLiveTimeline().getEvents().forEach(ev => renderMessage(ev));
        }
        startTelemetryPoll();
      } else if (state === 'ERROR') {
        setStatus('', 'Sync Error');
        showError('Sync error: ' + (data?.error || 'unknown'));
      } else if (state === 'RECONNECTING') {
        setStatus('connecting', 'Reconnecting...');
      } else if (state === 'SYNCING') {
        setStatus('connected', 'Connected');
      }
    });

    client.on('Room.timeline', (event, roomObj, toStartOfTimeline) => {
      if (roomObj && roomObj.roomId === room && !toStartOfTimeline) {
        renderMessage(event);
      }
    });

  } catch (err) {
    console.error('Connection failed:', err);
    setStatus('', 'Failed');
    showError('Connection failed: ' + (err.message || err));
  }
}

function clearFeed() {
  document.getElementById('feed').innerHTML =
    '<div class="empty-state" id="emptyState"><div class="icon">&#9776;</div><p>Waiting for messages...</p></div>';
  msgCount = 0;
  document.getElementById('msgCount').textContent = '0';
  document.getElementById('cpuVal').textContent = '--';
  document.getElementById('memVal').textContent = '--';
  document.getElementById('diskVal').textContent = '--';
  document.getElementById('loadVal').textContent = '--';
  document.getElementById('procBody').innerHTML = '';
  document.getElementById('procCount').textContent = '0';
  document.getElementById('smithersPanel').style.display = 'none';
  const runEl = document.getElementById('smithersRun');
  if (runEl) runEl.remove();
  lastStructuredData = null;
}

document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('clearBtn').addEventListener('click', clearFeed);

if (hsInput.value && roomInput.value && tokenInput.value) {
  connect();
} else {
  document.getElementById('configPanel').style.display = '';
}
