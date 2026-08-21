import crypto from 'crypto';
import {
  hashPassword,
  verifyPassword,
  loadAuthRecord,
  saveAuthRecord,
  isAuthInitialized,
  HASH_ITERATIONS
} from './authStore.js';

// Session Secret: from environment or randomly generated at runtime
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE_NAME = 'agm_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_PASSWORD_LENGTH = 12;

// In-Memory Sessions Map with auto-pruning
const sessions = new Map();

// Rate Limiting Map: ip -> { count, firstAttempt, lockedUntil }
const loginRateLimit = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function pruneRateLimitEntries(now = Date.now()) {
  for (const [ip, entry] of loginRateLimit.entries()) {
    const expiresAt = Math.max(
      (entry.firstAttempt || 0) + RATE_LIMIT_WINDOW_MS,
      entry.lockedUntil || 0
    );
    if (expiresAt <= now) loginRateLimit.delete(ip);
  }

  while (loginRateLimit.size > MAX_RATE_LIMIT_ENTRIES) {
    loginRateLimit.delete(loginRateLimit.keys().next().value);
  }
}

export function checkRateLimit(ip) {
  const now = Date.now();
  pruneRateLimitEntries(now);
  const entry = loginRateLimit.get(ip);
  if (!entry) return { allowed: true };

  if (entry.lockedUntil && entry.lockedUntil > now) {
    const remainingSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, error: `登录尝试过多，已锁定。请在 ${remainingSec} 秒后再试。` };
  }

  if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    loginRateLimit.delete(ip);
    return { allowed: true };
  }

  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    return { allowed: false, error: '登录尝试过多，已锁定 5 分钟。' };
  }

  return { allowed: true };
}

export function recordLoginAttempt(ip, success) {
  const now = Date.now();
  pruneRateLimitEntries(now);
  if (success) {
    loginRateLimit.delete(ip);
    return;
  }

  const entry = loginRateLimit.get(ip) || { count: 0, firstAttempt: now, lockedUntil: null };
  entry.count += 1;
  loginRateLimit.set(ip, entry);
  pruneRateLimitEntries(now);
}

export function recordFailedAttempt(ip) {
  recordLoginAttempt(ip, false);
}

export function resetFailedAttempts(ip) {
  loginRateLimit.delete(ip);
}

// Cookie Signing Helper
export function signCookie(value) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `s:${value}.${hmac}`;
}

export function unsignCookie(signedValue) {
  if (!signedValue || typeof signedValue !== 'string' || !signedValue.startsWith('s:')) return null;
  const raw = signedValue.slice(2);
  const lastDot = raw.lastIndexOf('.');
  if (lastDot === -1) return null;

  const value = raw.slice(0, lastDot);
  const signature = raw.slice(lastDot + 1);
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');

  if (signature.length !== expectedSig.length) return null;
  const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  return isValid ? value : null;
}

// Session Creation & Verification
function pruneExpiredSessions(now = Date.now()) {
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}

export function createSession(user = { username: 'admin' }) {
  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    user,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  sessions.set(token, session);
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }

  // Sliding window: renew session if more than 1 hour has passed since last activity
  const ONE_HOUR_MS = 60 * 60 * 1000;
  if (Date.now() - (session.lastActiveAt || session.createdAt) > ONE_HOUR_MS) {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    session.lastActiveAt = Date.now();
  }

  return session;
}

export function destroySession(token) {
  if (token) {
    sessions.delete(token);
  }
}

export function isPasswordSet() {
  return isAuthInitialized();
}

export function setInitialPassword(password, username = 'admin') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码长度至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
  }
  if (typeof username !== 'string') throw new Error('管理员用户名必须为字符串');
  const cleanUser = (username || 'admin').trim();
  if (!cleanUser) {
    throw new Error('管理员用户名不能为空');
  }
  if (cleanUser.length > 64 || /[\u0000-\u001f\u007f]/.test(cleanUser)) {
    throw new Error('管理员用户名不得超过 64 个字符或包含控制字符');
  }

  const record = {
    username: cleanUser,
    ...hashPassword(password)
  };
  saveAuthRecord(record);
  return true;
}

export function authenticateUser(username, password, ip = '127.0.0.1') {
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return { success: false, error: rateCheck.error };
  }

  const authRecord = loadAuthRecord();
  if (!authRecord) {
    return { success: false, needsSetup: true, error: '系统尚未配置管理员密码，请先完成初始密码设置。' };
  }

  const inputUser = typeof username === 'string' ? username.trim() : '';
  const isUsernameMatch = (inputUser === authRecord.username);
  const isPasswordMatch = isUsernameMatch && verifyPassword(password || '', authRecord);

  const isValid = isUsernameMatch && isPasswordMatch;
  recordLoginAttempt(ip, isValid);

  if (!isValid) {
    return { success: false, error: '用户名或密码错误' };
  }

  const token = createSession({ username: authRecord.username });
  return { success: true, token, username: authRecord.username };
}

// HTTP Cookie Parser Helper
export function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (name) {
      const value = parts.join('=')?.trim() || '';
      try {
        list[name] = decodeURIComponent(value);
      } catch (_) {
        // Ignore malformed values instead of turning authentication into a
        // 500 response for the entire request.
      }
    }
  });

  return list;
}

// Express Auth Middleware
export function authMiddleware(req, res, next) {
  // Compute normalized relative path under /api
  const reqUrl = req.originalUrl || req.url || '';
  const pathname = reqUrl.split('?')[0];

  // Whitelist of public endpoints
  const publicEndpoints = new Set([
    '/api/auth/status',
    '/api/auth/auth-status',
    '/api/auth/login',
    '/api/auth/setup'
  ]);

  if (publicEndpoints.has(pathname)) {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  const signedToken = cookies[SESSION_COOKIE_NAME];
  const token = unsignCookie(signedToken);
  const session = getSession(token);

  if (!session) {
    return res.status(401).json({
      success: false,
      error: '未授权或登录已过期，请重新登录',
      code: 'UNAUTHORIZED'
    });
  }

  req.session = session;
  req.user = session.user;
  next();
}

// WebSocket Upgrade Authenticator
export function authenticateWebSocketRequest(request) {
  try {
    const cookies = parseCookies(request.headers.cookie);
    const signedToken = cookies[SESSION_COOKIE_NAME];
    const token = unsignCookie(signedToken);
    const session = getSession(token);
    return Boolean(session);
  } catch (_) {
    return false;
  }
}

export {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  HASH_ITERATIONS
};
