const API = '/api/chat';
const CACHE_KEY = 'vercel-temp-chat:messages:v1';
const NICKNAME_KEY = 'vercel-temp-chat:nickname:v1';
const ADMIN_PASSWORD_KEY = 'vercel-temp-chat:admin-password:v1';
const POLL_MS = 3000;

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
  cancelAdminBtn: document.querySelector('#cancelAdminBtn')
};

let messages = [];
let serverClockOffset = 0;
let noticeTimer = null;
let pollTimer = null;
let requestInFlight = false;

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

async function syncMessages({ quiet = false } = {}) {
  if (requestInFlight) return;
  requestInFlight = true;

  try {
    const response = await fetch(`${API}?t=${Date.now()}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '同步失败');

    if (Number.isFinite(data.serverTime)) {
      serverClockOffset = data.serverTime - Date.now();
    }

    messages = mergeMessages(messages, data.messages);
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
      messages: merged
    };
    downloadJson(exported);
    showNotice(`已导出 ${merged.length} 条消息`, 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

el.importInput.addEventListener('change', async () => {
  const file = el.importInput.files?.[0];
  if (!file) return;

  try {
    if (file.size > 2 * 1024 * 1024) {
      throw new Error('导入文件不能超过 2MB');
    }

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

function startTimers() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => syncMessages({ quiet: true }), POLL_MS);

  setInterval(() => {
    const before = messages.length;
    messages = pruneExpired(messages);
    if (messages.length !== before) render();
    else {
      // 即使没有消息被删除，也刷新“还有几分钟删除”的文案。
      render();
    }
  }, 15_000);
}

function init() {
  el.nickname.value = localStorage.getItem(NICKNAME_KEY) || '';
  loadCache();
  setAdminUi();
  render({ stickToBottom: true });
  syncMessages({ quiet: true });
  startTimers();
  el.input.focus();
}

init();
