const API = '/api/chat';
const CACHE_KEY = 'vercel-temp-chat:messages:v1';
const NICKNAME_KEY = 'vercel-temp-chat:nickname:v1';
const ADMIN_PASSWORD_KEY = 'vercel-temp-chat:admin-password:v1';
const PEER_ID_KEY = 'vercel-temp-chat:peer-id:v1';
const VISIBLE_POLL_MS = 10000;
const HIDDEN_POLL_MS = 60000;
const FAST_POLL_MS = 1000;
const FILE_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const ICE_TIMEOUT_MS = 7000;
const CONNECTION_TIMEOUT_MS = 18000;

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  // 不配置 TURN：失败时不会把文件退化成服务器中继。
  iceTransportPolicy: 'all'
};

const el = {
  messages: document.querySelector('#messages'),
  form: document.querySelector('#messageForm'),
  nickname: document.querySelector('#nicknameInput'),
  input: document.querySelector('#messageInput'),
  charCount: document.querySelector('#charCount'),
  sendBtn: document.querySelector('#sendBtn'),
  adminBtn: document.querySelector('#adminBtn'),
  adminPanel: document.querySelector('#adminPanel'),
  statusBadge: document.querySelector('#statusBadge'),
  exportBtn: document.querySelector('#exportBtn'),
  importInput: document.querySelector('#importInput'),
  clearBtn: document.querySelector('#clearBtn'),
  logoutBtn: document.querySelector('#logoutBtn'),
  notice: document.querySelector('#notice'),
  adminDialog: document.querySelector('#adminDialog'),
  adminLoginForm: document.querySelector('#adminLoginForm'),
  adminPasswordInput: document.querySelector('#adminPasswordInput'),
  cancelAdminBtn: document.querySelector('#cancelAdminBtn'),
  peerSelect: document.querySelector('#peerSelect'),
  peerCount: document.querySelector('#peerCount'),
  p2pFileInput: document.querySelector('#p2pFileInput'),
  sendFileBtn: document.querySelector('#sendFileBtn'),
  selectedFiles: document.querySelector('#selectedFiles'),
  transferList: document.querySelector('#transferList')
};

let messages = [];
let serverClockOffset = 0;
let noticeTimer = null;
let pollTimer = null;
let fastPollUntil = 0;
let requestInFlight = false;
let peers = [];
let selectedP2PFiles = [];

const processedSignals = new Set();
const peerConnections = new Map();
const dataChannels = new Map();
const incomingTransfers = new Map();
const outgoingQueues = new Map();

function createPeerId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function getPeerId() {
  let value = sessionStorage.getItem(PEER_ID_KEY);
  if (!value) {
    value = createPeerId();
    sessionStorage.setItem(PEER_ID_KEY, value);
  }
  return value;
}

const SELF_PEER_ID = getPeerId();

function getNickname() {
  return el.nickname.value.trim() || (isAdmin() ? '管理员' : '匿名访客');
}

function getAdminPassword() {
  return sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';
}

function isAdmin() {
  return Boolean(getAdminPassword());
}

function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const password = getAdminPassword();
  if (password) headers['X-Admin-Password'] = password;
  return headers;
}

function approximateServerNow() {
  return Date.now() + serverClockOffset;
}

function pruneExpired(list) {
  const t = approximateServerNow();
  return list.filter((message) => message.expiresAt === null || Number(message.expiresAt) > t);
}

function mergeMessages(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const message of Array.isArray(group) ? group : []) {
      if (!message || typeof message !== 'object' || !message.id) continue;
      map.set(message.id, message);
    }
  }

  return pruneExpired([...map.values()])
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .slice(-500);
}

function saveCache() {
  messages = pruneExpired(messages).slice(-500);
  localStorage.setItem(CACHE_KEY, JSON.stringify(messages));
}

function loadCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
    messages = pruneExpired(Array.isArray(cached) ? cached : []);
  } catch {
    messages = [];
  }
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(timestamp));
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && n >= 1024; i += 1) {
    n /= 1024;
    unit = units[i];
  }
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${unit}`;
}

function formatRemaining(expiresAt) {
  if (expiresAt === null) return '管理员消息';
  const remaining = Math.max(0, Number(expiresAt) - approximateServerNow());
  const minutes = Math.ceil(remaining / 60000);
  return minutes > 0 ? `约 ${minutes} 分钟后删除` : '即将删除';
}

function render({ stickToBottom = false } = {}) {
  messages = pruneExpired(messages);
  saveCache();

  const wasNearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 100;
  el.messages.replaceChildren();

  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有消息。\n发一条试试吧。';
    el.messages.appendChild(empty);
    return;
  }

  for (const message of messages) {
    const item = document.createElement('article');
    item.className = `message ${message.role === 'admin' ? 'admin' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const name = document.createElement('span');
    name.className = 'message-name';
    name.textContent = message.nickname || '匿名';

    const time = document.createElement('time');
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = formatTime(message.createdAt);

    meta.append(name);
    if (message.role === 'admin') {
      const tag = document.createElement('span');
      tag.className = 'role-tag';
      tag.textContent = '管理员';
      meta.append(tag);
    }
    meta.append(time);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = message.content;

    const expire = document.createElement('div');
    expire.className = 'expire';
    expire.textContent = formatRemaining(message.expiresAt);

    item.append(meta, bubble, expire);
    el.messages.appendChild(item);
  }

  if (stickToBottom || wasNearBottom) {
    el.messages.scrollTop = el.messages.scrollHeight;
  }
}

function setAdminUi() {
  const admin = isAdmin();
  el.adminPanel.classList.toggle('hidden', !admin);
  el.statusBadge.textContent = admin ? '管理员' : '访客';
  el.statusBadge.className = `badge ${admin ? 'admin' : 'visitor'}`;
  el.adminBtn.classList.toggle('hidden', admin);
  el.nickname.placeholder = admin ? '管理员昵称' : '你的昵称';
}

function showNotice(text, type = 'info', timeout = 2600) {
  clearTimeout(noticeTimer);
  el.notice.textContent = text;
  el.notice.className = `notice ${type === 'info' ? '' : type}`.trim();
  el.notice.classList.remove('hidden');
  noticeTimer = setTimeout(() => el.notice.classList.add('hidden'), timeout);
}

async function request(body, method = 'POST') {
  const response = await fetch(API, {
    method,
    headers: method === 'GET' ? { 'Cache-Control': 'no-cache' } : apiHeaders(),
    body: method === 'GET' ? undefined : JSON.stringify(body),
    cache: 'no-store'
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = { ok: false, error: `服务器返回异常状态：${response.status}` };
  }

  if (!response.ok) {
    const error = new Error(data.error || `请求失败：${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function renderPeers(nextPeers) {
  const previous = el.peerSelect.value;
  peers = Array.isArray(nextPeers) ? nextPeers : [];

  el.peerCount.textContent = `${peers.length} 个其他在线用户`;
  el.peerSelect.replaceChildren();

  if (!peers.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无其他在线用户';
    el.peerSelect.appendChild(option);
    el.peerSelect.disabled = true;
  } else {
    el.peerSelect.disabled = false;

    if (peers.length > 1) {
      const all = document.createElement('option');
      all.value = '*';
      all.textContent = `所有在线用户（${peers.length}）`;
      el.peerSelect.appendChild(all);
    }

    for (const peer of peers) {
      const option = document.createElement('option');
      option.value = peer.id;
      option.textContent = `${peer.nickname || '匿名访客'} · ${peer.id.slice(0, 6)}`;
      el.peerSelect.appendChild(option);
    }

    if ([...el.peerSelect.options].some((option) => option.value === previous)) {
      el.peerSelect.value = previous;
    }
  }

  updateSendFileButton();
}

function updateSendFileButton() {
  const hasTarget = Boolean(el.peerSelect.value) && !el.peerSelect.disabled;
  el.sendFileBtn.disabled = !hasTarget || selectedP2PFiles.length === 0;
}

function renderSelectedFiles() {
  if (!selectedP2PFiles.length) {
    el.selectedFiles.textContent = '可发送图片、视频、ZIP/RAR/7z、DMG、EXE、APK 等任意文件。';
  } else {
    const total = selectedP2PFiles.reduce((sum, file) => sum + file.size, 0);
    el.selectedFiles.textContent = `已选择 ${selectedP2PFiles.length} 个文件，共 ${formatBytes(total)}：${selectedP2PFiles.map((f) => f.name).join('、')}`;
  }
  updateSendFileButton();
}

function peerName(peerId) {
  return peers.find((peer) => peer.id === peerId)?.nickname || `用户 ${peerId.slice(0, 6)}`;
}

function currentPollDelay() {
  if (Date.now() < fastPollUntil) return FAST_POLL_MS;
  return document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;
}

function schedulePoll(delay = currentPollDelay()) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLoop, delay);
}

function boostPolling(durationMs = 25000) {
  fastPollUntil = Math.max(fastPollUntil, Date.now() + durationMs);
  schedulePoll(150);
}

async function sendSignal(toPeerId, signalType, data = null) {
  boostPolling();
  return request({
    action: 'signal',
    fromPeerId: SELF_PEER_ID,
    toPeerId,
    signalType,
    data,
    nickname: getNickname()
  });
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, ICE_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === 'complete') done();
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function setupDataChannel(remotePeerId, channel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 512 * 1024;
  dataChannels.set(remotePeerId, channel);

  channel.addEventListener('open', () => {
    addTransferStatus({
      id: `connection-${remotePeerId}`,
      direction: '连接',
      name: peerName(remotePeerId),
      status: 'P2P 通道已建立',
      progress: 100
    });
  });

  channel.addEventListener('close', () => {
    if (dataChannels.get(remotePeerId) === channel) dataChannels.delete(remotePeerId);
  });

  channel.addEventListener('error', () => {
    showNotice(`与 ${peerName(remotePeerId)} 的 P2P 通道发生错误`, 'error', 4000);
  });

  channel.addEventListener('message', (event) => handleDataMessage(remotePeerId, event.data));
}

function createPeerConnection(remotePeerId, { initiator = false } = {}) {
  const old = peerConnections.get(remotePeerId);
  if (old && old.connectionState !== 'closed' && old.connectionState !== 'failed') {
    return old;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections.set(remotePeerId, pc);

  pc.addEventListener('datachannel', (event) => setupDataChannel(remotePeerId, event.channel));

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') {
      showNotice(`无法与 ${peerName(remotePeerId)} 建立直连。可能是 NAT/防火墙限制。`, 'error', 5000);
      closePeer(remotePeerId, false);
    }
    if (pc.connectionState === 'closed') closePeer(remotePeerId, false);
  });

  if (initiator) {
    const channel = pc.createDataChannel('p2p-files', { ordered: true });
    setupDataChannel(remotePeerId, channel);
  }

  return pc;
}

function closePeer(remotePeerId, sendBye = true) {
  const channel = dataChannels.get(remotePeerId);
  if (channel) {
    try { channel.close(); } catch {}
    dataChannels.delete(remotePeerId);
  }

  const pc = peerConnections.get(remotePeerId);
  if (pc) {
    try { pc.close(); } catch {}
    peerConnections.delete(remotePeerId);
  }

  incomingTransfers.delete(remotePeerId);
  if (sendBye) sendSignal(remotePeerId, 'bye').catch(() => {});
}

async function establishConnection(remotePeerId) {
  if (!window.RTCPeerConnection) throw new Error('当前浏览器不支持 WebRTC P2P');

  const openChannel = dataChannels.get(remotePeerId);
  if (openChannel?.readyState === 'open') return openChannel;

  closePeer(remotePeerId, false);
  const pc = createPeerConnection(remotePeerId, { initiator: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  await sendSignal(remotePeerId, 'offer', {
    type: pc.localDescription.type,
    sdp: pc.localDescription.sdp
  });

  return waitForDataChannel(remotePeerId);
}

function waitForDataChannel(remotePeerId) {
  const existing = dataChannels.get(remotePeerId);
  if (existing?.readyState === 'open') return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const channel = dataChannels.get(remotePeerId);
      if (channel?.readyState === 'open') {
        clearInterval(timer);
        resolve(channel);
        return;
      }

      const pc = peerConnections.get(remotePeerId);
      if (pc?.connectionState === 'failed' || Date.now() - started > CONNECTION_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`与 ${peerName(remotePeerId)} 建立 P2P 连接超时`));
      }
    }, 120);
  });
}

async function handleSignal(signal) {
  if (!signal?.id || processedSignals.has(signal.id)) return;
  boostPolling(18000);
  processedSignals.add(signal.id);
  if (processedSignals.size > 3000) processedSignals.clear();

  const remotePeerId = signal.fromPeerId;
  if (!remotePeerId || remotePeerId === SELF_PEER_ID) return;

  if (signal.signalType === 'bye') {
    closePeer(remotePeerId, false);
    return;
  }

  try {
    if (signal.signalType === 'offer') {
      // 如果双方同时发起，统一由 peerId 较小的一方保留主动 offer，避免 offer 碰撞。
      const existing = peerConnections.get(remotePeerId);
      if (existing && existing.signalingState !== 'stable') {
        if (SELF_PEER_ID < remotePeerId) return;
        closePeer(remotePeerId, false);
      }

      const pc = createPeerConnection(remotePeerId);
      await pc.setRemoteDescription(signal.data);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      await sendSignal(remotePeerId, 'answer', {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      });
      return;
    }

    if (signal.signalType === 'answer') {
      const pc = peerConnections.get(remotePeerId);
      if (!pc || pc.signalingState === 'closed') return;
      if (!pc.remoteDescription) await pc.setRemoteDescription(signal.data);
    }
  } catch (error) {
    console.error('P2P signaling failed', error);
    showNotice(`P2P 握手失败：${error.message}`, 'error', 4500);
    closePeer(remotePeerId, false);
  }
}

function addTransferStatus({ id, direction, name, status, progress = 0, blob = null, fileType = '', fileName = '' }) {
  let item = el.transferList.querySelector(`[data-transfer-id="${CSS.escape(id)}"]`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'transfer-item';
    item.dataset.transferId = id;
    item.innerHTML = `
      <div class="transfer-main">
        <div class="transfer-title"></div>
        <div class="transfer-status"></div>
      </div>
      <div class="transfer-progress"><i></i></div>
      <div class="transfer-actions"></div>
    `;
    el.transferList.prepend(item);
  }

  item.querySelector('.transfer-title').textContent = `${direction} · ${name}`;
  item.querySelector('.transfer-status').textContent = status;
  item.querySelector('.transfer-progress i').style.width = `${Math.max(0, Math.min(100, progress))}%`;

  if (blob) {
    const actions = item.querySelector('.transfer-actions');
    actions.replaceChildren();

    const url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.className = 'download-link';
    download.href = url;
    download.download = fileName || name;
    download.textContent = '下载';
    actions.appendChild(download);

    if (fileType.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'transfer-preview';
      img.src = url;
      img.alt = fileName || name;
      actions.appendChild(img);
    } else if (fileType.startsWith('video/')) {
      const video = document.createElement('video');
      video.className = 'transfer-preview video';
      video.src = url;
      video.controls = true;
      video.preload = 'metadata';
      actions.appendChild(video);
    }
  }
}

async function waitForBuffer(channel) {
  if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('P2P 发送缓冲等待超时'));
    }, 20000);

    function cleanup() {
      clearTimeout(timeout);
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
    }
    function onLow() {
      cleanup();
      resolve();
    }
    function onClose() {
      cleanup();
      reject(new Error('P2P 通道已关闭'));
    }

    channel.addEventListener('bufferedamountlow', onLow, { once: true });
    channel.addEventListener('close', onClose, { once: true });
  });
}

async function sendOneFile(remotePeerId, file) {
  const channel = await establishConnection(remotePeerId);
  const transferId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  channel.send(JSON.stringify({
    kind: 'file-meta',
    id: transferId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || 0
  }));

  addTransferStatus({
    id: transferId,
    direction: '发送',
    name: file.name,
    status: `给 ${peerName(remotePeerId)} · 0 / ${formatBytes(file.size)}`,
    progress: 0
  });

  let offset = 0;
  while (offset < file.size) {
    if (channel.readyState !== 'open') throw new Error('P2P 通道已断开');
    await waitForBuffer(channel);

    const end = Math.min(offset + FILE_CHUNK_SIZE, file.size);
    const chunk = await file.slice(offset, end).arrayBuffer();
    channel.send(chunk);
    offset = end;

    const progress = file.size ? (offset / file.size) * 100 : 100;
    addTransferStatus({
      id: transferId,
      direction: '发送',
      name: file.name,
      status: `给 ${peerName(remotePeerId)} · ${formatBytes(offset)} / ${formatBytes(file.size)}`,
      progress
    });
  }

  channel.send(JSON.stringify({ kind: 'file-end', id: transferId }));
  addTransferStatus({
    id: transferId,
    direction: '发送',
    name: file.name,
    status: `已发送给 ${peerName(remotePeerId)} · ${formatBytes(file.size)}`,
    progress: 100
  });
}

function queueFileSend(remotePeerId, file) {
  const previous = outgoingQueues.get(remotePeerId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => sendOneFile(remotePeerId, file));

  outgoingQueues.set(remotePeerId, next);
  next.finally(() => {
    if (outgoingQueues.get(remotePeerId) === next) outgoingQueues.delete(remotePeerId);
  });
  return next;
}

async function handleDataMessage(remotePeerId, data) {
  if (typeof data === 'string') {
    let packet;
    try { packet = JSON.parse(data); } catch { return; }

    if (packet.kind === 'file-meta') {
      incomingTransfers.set(remotePeerId, {
        id: packet.id,
        name: String(packet.name || 'unnamed-file'),
        size: Number(packet.size) || 0,
        type: String(packet.type || 'application/octet-stream'),
        chunks: [],
        received: 0
      });

      addTransferStatus({
        id: packet.id,
        direction: '接收',
        name: packet.name,
        status: `来自 ${peerName(remotePeerId)} · 0 / ${formatBytes(packet.size)}`,
        progress: 0
      });
      return;
    }

    if (packet.kind === 'file-end') {
      const transfer = incomingTransfers.get(remotePeerId);
      if (!transfer || transfer.id !== packet.id) return;

      const blob = new Blob(transfer.chunks, { type: transfer.type });
      const complete = transfer.size === 0 || blob.size === transfer.size;
      addTransferStatus({
        id: transfer.id,
        direction: '接收',
        name: transfer.name,
        status: complete
          ? `接收完成 · ${formatBytes(blob.size)} · 点击下载`
          : `大小校验异常：收到 ${formatBytes(blob.size)} / 应为 ${formatBytes(transfer.size)}`,
        progress: 100,
        blob,
        fileType: transfer.type,
        fileName: transfer.name
      });

      incomingTransfers.delete(remotePeerId);
      if (complete) showNotice(`已收到文件：${transfer.name}`, 'success', 4000);
      return;
    }

    return;
  }

  const transfer = incomingTransfers.get(remotePeerId);
  if (!transfer) return;

  const chunk = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  transfer.chunks.push(chunk);
  transfer.received += chunk.byteLength;
  const progress = transfer.size ? (transfer.received / transfer.size) * 100 : 100;

  addTransferStatus({
    id: transfer.id,
    direction: '接收',
    name: transfer.name,
    status: `来自 ${peerName(remotePeerId)} · ${formatBytes(transfer.received)} / ${formatBytes(transfer.size)}`,
    progress
  });
}

async function syncMessages({ quiet = false } = {}) {
  if (requestInFlight) return;
  requestInFlight = true;

  try {
    const params = new URLSearchParams({
      t: String(Date.now()),
      peerId: SELF_PEER_ID,
      nickname: getNickname()
    });
    const response = await fetch(`${API}?${params}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '同步失败');

    if (Number.isFinite(data.serverTime)) {
      serverClockOffset = data.serverTime - Date.now();
    }

    messages = mergeMessages(messages, data.messages);
    renderPeers(data.peers);

    for (const signal of Array.isArray(data.signals) ? data.signals : []) {
      await handleSignal(signal);
    }

    render();
  } catch (error) {
    if (!quiet) showNotice(`暂时无法同步服务器：${error.message}`, 'error', 4000);
  } finally {
    requestInFlight = false;
  }
}

async function sendMessage() {
  const nickname = el.nickname.value.trim() || (isAdmin() ? '管理员' : '匿名');
  const content = el.input.value.trim();
  if (!content) return;

  el.sendBtn.disabled = true;
  try {
    const data = await request({ action: 'send', nickname, content });
    messages = mergeMessages(messages, data.messages, data.message ? [data.message] : []);
    localStorage.setItem(NICKNAME_KEY, nickname);
    el.input.value = '';
    el.charCount.textContent = '0 / 2000';
    render({ stickToBottom: true });
  } catch (error) {
    if (error.status === 401 && isAdmin()) {
      sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
      setAdminUi();
      showNotice('管理员密码已失效，请重新登录', 'error');
    } else {
      showNotice(error.message, 'error');
    }
  } finally {
    el.sendBtn.disabled = false;
    el.input.focus();
  }
}

async function loginAdmin(password) {
  const response = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Password': password
    },
    body: JSON.stringify({ action: 'login' }),
    cache: 'no-store'
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '登录失败');

  sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
  setAdminUi();
}

function downloadJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `temp-chat-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendMessage();
});

el.input.addEventListener('input', () => {
  el.charCount.textContent = `${el.input.value.length} / 2000`;
});

el.input.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    await sendMessage();
  }
});

el.nickname.addEventListener('change', () => {
  localStorage.setItem(NICKNAME_KEY, el.nickname.value.trim());
  syncMessages({ quiet: true });
});

el.adminBtn.addEventListener('click', () => {
  el.adminPasswordInput.value = '';
  el.adminDialog.showModal();
  setTimeout(() => el.adminPasswordInput.focus(), 30);
});

el.cancelAdminBtn.addEventListener('click', () => el.adminDialog.close());

el.adminLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = el.adminPasswordInput.value;
  if (!password) return;

  try {
    await loginAdmin(password);
    el.adminDialog.close();
    showNotice('管理员登录成功', 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

el.logoutBtn.addEventListener('click', () => {
  sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
  setAdminUi();
  showNotice('已退出管理员模式');
});

el.exportBtn.addEventListener('click', async () => {
  try {
    const data = await request({ action: 'export' });
    const merged = mergeMessages(messages, data.messages);
    const exported = {
      ...data,
      source: 'server-memory+browser-cache',
      note: 'P2P 文件二进制不会写入 JSON。',
      messages: merged
    };
    downloadJson(exported);
    showNotice(`已导出 ${merged.length} 条文字消息`, 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

el.importInput.addEventListener('change', async () => {
  const file = el.importInput.files?.[0];
  if (!file) return;

  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('导入文件不能超过 2MB');

    const parsed = JSON.parse(await file.text());
    const data = await request({
      action: 'import',
      messages: Array.isArray(parsed) ? parsed : parsed.messages
    });

    messages = mergeMessages(messages, data.messages);
    render({ stickToBottom: true });
    showNotice(`成功导入 ${data.importedCount} 条消息`, 'success');
  } catch (error) {
    showNotice(`导入失败：${error.message}`, 'error', 4200);
  } finally {
    el.importInput.value = '';
  }
});

el.clearBtn.addEventListener('click', async () => {
  const confirmed = window.confirm('确定要清空当前服务器实例里的全部聊天记录吗？');
  if (!confirmed) return;

  try {
    await request({ action: 'clear' });
    messages = [];
    saveCache();
    render();
    showNotice('聊天记录已清空', 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

el.p2pFileInput.addEventListener('change', () => {
  selectedP2PFiles = [...(el.p2pFileInput.files || [])];
  renderSelectedFiles();
});

el.peerSelect.addEventListener('change', updateSendFileButton);

el.sendFileBtn.addEventListener('click', async () => {
  if (!selectedP2PFiles.length) return;

  const target = el.peerSelect.value;
  const targets = target === '*' ? peers.map((peer) => peer.id) : [target].filter(Boolean);
  if (!targets.length) {
    showNotice('请选择在线接收者', 'error');
    return;
  }

  el.sendFileBtn.disabled = true;
  boostPolling(35000);
  const files = [...selectedP2PFiles];
  try {
    for (const remotePeerId of targets) {
      for (const file of files) {
        await queueFileSend(remotePeerId, file);
      }
    }
    showNotice(`P2P 文件发送完成`, 'success', 3500);
    selectedP2PFiles = [];
    el.p2pFileInput.value = '';
    renderSelectedFiles();
  } catch (error) {
    showNotice(`文件发送失败：${error.message}`, 'error', 5200);
  } finally {
    updateSendFileButton();
  }
});

async function pollLoop() {
  await syncMessages({ quiet: true });
  schedulePoll();
}

function startTimers() {
  schedulePoll(1000);

  setInterval(() => {
    messages = pruneExpired(messages);
    render();
  }, 15_000);
}

function init() {
  el.nickname.value = localStorage.getItem(NICKNAME_KEY) || '';
  loadCache();
  setAdminUi();
  renderSelectedFiles();
  renderPeers([]);
  render({ stickToBottom: true });
  syncMessages({ quiet: true });
  startTimers();
  el.input.focus();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncMessages({ quiet: true });
  schedulePoll(document.hidden ? HIDDEN_POLL_MS : 250);
});

window.addEventListener('beforeunload', () => {
  for (const peerId of peerConnections.keys()) closePeer(peerId, false);
});

init();
