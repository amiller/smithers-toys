// The Vite ESM bundle exports via window.MatrixSDK
import '/js/matrix-sdk.esm.js';

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

hsInput.value = localStorage.getItem(HOMESERVER_KEY) || '';
roomInput.value = localStorage.getItem(ROOM_KEY) || '';
tokenInput.value = localStorage.getItem(TOKEN_KEY) || '';

let client = null;
let connectedAt = null;
let uptimeInterval = null;
let msgCount = 0;

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

function updateStatCards(body) {
  if (!body.includes('CVM Telemetry')) return;
  const t = parseTelemetry(body);
  if (t.cpu) document.getElementById('cpuVal').textContent = t.cpu;
  if (t.mem) document.getElementById('memVal').textContent = t.mem.split('(')[0].trim();
  if (t.disk) document.getElementById('diskVal').textContent = t.disk;
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

  const card = document.createElement('div');
  const isTelemetry = content.body.includes('CVM Telemetry');
  card.className = 'message-card' + (isTelemetry ? ' telemetry' : '');

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
    const t = parseTelemetry(content.body);
    const keys = Object.keys(t).filter(k => k !== 'timestamp' && !k.includes('smithers') && !k.includes('telemetry'));
    if (keys.length > 0) {
      telemHtml = '<div class="telemetry-grid">' +
        keys.map(k => `<div class="telem-item"><div class="tl">${escapeHtml(k)}</div><div class="tv">${escapeHtml(t[k])}</div></div>`).join('') +
        '</div>';
    }
  }

  card.innerHTML =
    `<div class="meta">
      <span class="sender">${escapeHtml(sender)}</span>
      ${badges}
      <span class="time">${timeStr}</span>
    </div>
    <div class="body">${bodyHtml}</div>
    ${telemHtml}`;

  const feed = document.getElementById('feed');
  feed.insertBefore(card, feed.firstChild);
  while (feed.children.length > 100) feed.removeChild(feed.lastChild);
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

    // Initialize E2EE via Rust crypto (WASM)
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
}

document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('clearBtn').addEventListener('click', clearFeed);

// Auto-connect if saved
if (hsInput.value && roomInput.value && tokenInput.value) {
  connect();
}
