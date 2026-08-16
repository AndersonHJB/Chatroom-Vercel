import crypto from 'node:crypto';

const VISITOR_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGES = 500;
const MAX_NAME_LENGTH = 30;
const MAX_CONTENT_LENGTH = 2000;

// 注意：这里只存在当前 Vercel Function 实例的内存里。
// 冷启动、扩容、重新部署都可能让它消失；这是“完全不使用存储”的必然限制。
const state = globalThis.__TEMP_CHAT_STATE__ || {
  messages: []
};

globalThis.__TEMP_CHAT_STATE__ = state;

function now() {
  return Date.now();
}

function cleanupExpired() {
  const t = now();
  state.messages = state.messages.filter((message) => {
    // 管理员消息 expiresAt === null，不按 30 分钟删除。
    if (message.expiresAt === null) return true;
    return Number(message.expiresAt) > t;
  });

  if (state.messages.length > MAX_MESSAGES) {
    state.messages = state.messages.slice(-MAX_MESSAGES);
  }
}

function isAdmin(req) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) return false;

  const provided = req.headers['x-admin-password'];
  if (typeof provided !== 'string') return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(configuredPassword);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function json(res, status, body) {
  setHeaders(res);
  return res.status(status).json(body);
}

function normalizeText(value, maxLength) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function publicMessages() {
  cleanupExpired();
  return [...state.messages].sort((a, b) => a.createdAt - b.createdAt);
}

function sanitizeImportedMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const nickname = normalizeText(raw.nickname, MAX_NAME_LENGTH) || '匿名';
  const content = normalizeText(raw.content, MAX_CONTENT_LENGTH);
  if (!content) return null;

  const role = raw.role === 'admin' ? 'admin' : 'visitor';
  const createdAt = Number(raw.createdAt);
  const safeCreatedAt = Number.isFinite(createdAt) ? createdAt : now();

  let expiresAt = null;
  if (role === 'visitor') {
    const requestedExpiresAt = Number(raw.expiresAt);
    expiresAt = Number.isFinite(requestedExpiresAt)
      ? requestedExpiresAt
      : safeCreatedAt + VISITOR_TTL_MS;

    // 已经过期的访客消息不导入。
    if (expiresAt <= now()) return null;
  }

  return {
    id: typeof raw.id === 'string' && raw.id.length <= 100 ? raw.id : crypto.randomUUID(),
    nickname,
    content,
    role,
    createdAt: safeCreatedAt,
    expiresAt
  };
}

export default async function handler(req, res) {
  cleanupExpired();

  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      messages: publicMessages(),
      serverTime: now(),
      visitorTtlMs: VISITOR_TTL_MS
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = body.action || 'send';

  if (action === 'login') {
    if (!process.env.ADMIN_PASSWORD) {
      return json(res, 500, {
        ok: false,
        error: '服务器尚未配置 ADMIN_PASSWORD 环境变量'
      });
    }

    return isAdmin(req)
      ? json(res, 200, { ok: true, admin: true })
      : json(res, 401, { ok: false, error: '管理员密码错误' });
  }

  if (action === 'send') {
    const nickname = normalizeText(body.nickname, MAX_NAME_LENGTH) || '匿名';
    const content = normalizeText(body.content, MAX_CONTENT_LENGTH);

    if (!content) {
      return json(res, 400, { ok: false, error: '消息不能为空' });
    }

    const admin = isAdmin(req);
    const createdAt = now();
    const message = {
      id: crypto.randomUUID(),
      nickname,
      content,
      role: admin ? 'admin' : 'visitor',
      createdAt,
      expiresAt: admin ? null : createdAt + VISITOR_TTL_MS
    };

    state.messages.push(message);
    cleanupExpired();

    return json(res, 201, {
      ok: true,
      message,
      messages: publicMessages()
    });
  }

  // 以下操作只允许管理员。
  if (!isAdmin(req)) {
    return json(res, 401, { ok: false, error: '需要管理员权限' });
  }

  if (action === 'export') {
    return json(res, 200, {
      ok: true,
      exportedAt: new Date().toISOString(),
      version: 1,
      messages: publicMessages()
    });
  }

  if (action === 'import') {
    const incoming = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.data?.messages)
        ? body.data.messages
        : [];

    if (!incoming.length) {
      return json(res, 400, { ok: false, error: 'JSON 中没有可导入的 messages 数组' });
    }

    const imported = incoming
      .slice(0, MAX_MESSAGES)
      .map(sanitizeImportedMessage)
      .filter(Boolean);

    // 按 id 合并，导入的数据覆盖同 id 的旧记录。
    const map = new Map(state.messages.map((m) => [m.id, m]));
    for (const message of imported) map.set(message.id, message);

    state.messages = [...map.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_MESSAGES);

    cleanupExpired();

    return json(res, 200, {
      ok: true,
      importedCount: imported.length,
      messages: publicMessages()
    });
  }

  if (action === 'clear') {
    state.messages = [];
    return json(res, 200, { ok: true, messages: [] });
  }

  return json(res, 400, { ok: false, error: '未知 action' });
}
