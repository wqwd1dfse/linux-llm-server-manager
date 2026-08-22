import crypto from 'crypto';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAsync,
  loadAuthRecord,
  saveAuthRecord,
  isAuthInitialized,
  HASH_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  validateAdminPassword
} from './authStore.js';
import { ConcurrencyLimiter } from './concurrencyLimiter.js';

function boundedEnvironmentInteger(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function createLoginHashLimiter(environment = process.env) {
  return new ConcurrencyLimiter(
    boundedEnvironmentInteger(environment.MAX_CONCURRENT_LOGIN_HASHES, 4, 1, 32),
    boundedEnvironmentInteger(environment.MAX_QUEUED_LOGIN_HASHES, 32, 0, 256),
    boundedEnvironmentInteger(environment.LOGIN_HASH_QUEUE_TIMEOUT_MS, 2_000, 100, 30_000)
  );
}

// PBKDF2 runs in libuv's worker pool. A process-wide limiter prevents callers
// spread across many source IPs from creating an unbounded native-work queue.
export const loginHashLimiter = createLoginHashLimiter();
const LOGIN_BUSY_ERROR_CODES = new Set(['QUEUE_FULL', 'QUEUE_TIMEOUT']);
const LOGIN_BUSY_MESSAGE = '登录服务繁忙，请稍后重试。';

// Session Secret: from environment or randomly generated at runtime
const configuredSessionSecret = String(process.env.SESSION_SECRET || '');
if (configuredSessionSecret && Buffer.byteLength(configuredSessionSecret, 'utf8') < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 bytes when explicitly configured');
}
if ([
  'replace_with_a_long_random_secret',
  'your_secure_session_secret_here',
  'change_this_to_a_random_long_string_in_production'
].includes(configuredSessionSecret.trim().toLowerCase())) {
  throw new Error('SESSION_SECRET is still set to a public example placeholder');
}
const SESSION_SECRET = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE_NAME = 'agm_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ACTIVE_SESSIONS = 1000;

// In-Memory Sessions Map with auto-pruning
const sessions = new Map();
const sessionInvalidationListeners = new Set();

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

function releaseFailedAttemptReservation(ip) {
  const entry = loginRateLimit.get(ip);
  if (!entry) return;
  entry.count = Math.max(0, entry.count - 1);
  if (entry.count < MAX_LOGIN_ATTEMPTS) entry.lockedUntil = null;
  if (entry.count === 0) {
    loginRateLimit.delete(ip);
  }
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
function notifySessionInvalidated(token) {
  for (const listener of sessionInvalidationListeners) {
    try { listener(token); } catch (_) {}
  }
}

function deleteSession(token) {
  if (!sessions.delete(token)) return false;
  notifySessionInvalidated(token);
  return true;
}

function pruneExpiredSessions(now = Date.now()) {
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) deleteSession(token);
  }
}

export function onSessionInvalidated(listener) {
  if (typeof listener !== 'function') throw new TypeError('Session invalidation listener must be a function');
  sessionInvalidationListeners.add(listener);
  return () => sessionInvalidationListeners.delete(listener);
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
  while (sessions.size > MAX_ACTIVE_SESSIONS) {
    deleteSession(sessions.keys().next().value);
  }
  return token;
}

export function getSession(token, options = {}) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    deleteSession(token);
    return null;
  }

  // Sliding window: renew session if more than 1 hour has passed since last activity
  const ONE_HOUR_MS = 60 * 60 * 1000;
  if (options.touch !== false && Date.now() - (session.lastActiveAt || session.createdAt) > ONE_HOUR_MS) {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    session.lastActiveAt = Date.now();
  }

  return session;
}

export function destroySession(token) {
  if (token) deleteSession(token);
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
  const passwordValidationError = validateAdminPassword(password);
  if (passwordValidationError) throw new Error(passwordValidationError);

  const record = {
    username: cleanUser,
    ...hashPassword(password)
  };
  saveAuthRecord(record);
  return true;
}

export async function authenticateUser(username, password, ip = '127.0.0.1') {
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return { success: false, error: rateCheck.error };
  }

  const authRecord = loadAuthRecord();
  if (!authRecord) {
    return { success: false, needsSetup: true, error: '系统尚未配置管理员密码，请先完成初始密码设置。' };
  }

  // Reserve the attempt before starting PBKDF2. Without this, a burst of
  // concurrent requests could all pass the limiter before any one of them
  // finished hashing and recorded its failure.
  recordFailedAttempt(ip);
  const inputUser = typeof username === 'string' ? username.trim() : '';
  const isUsernameMatch = (inputUser === authRecord.username);
  // Always perform the same password derivation for an initialized account so
  // username validity is not exposed through a large timing difference.
  let isPasswordMatch;
  try {
    isPasswordMatch = await loginHashLimiter.run(
      () => verifyPasswordAsync(password || '', authRecord)
    );
  } catch (error) {
    if (!LOGIN_BUSY_ERROR_CODES.has(error?.code)) throw error;
    // Capacity rejection is not a credential failure. The reservation still
    // protected the per-IP limiter while this request was queued.
    releaseFailedAttemptReservation(ip);
    return {
      success: false,
      busy: true,
      code: 'AUTH_BUSY',
      error: LOGIN_BUSY_MESSAGE,
      retryAfterSeconds: Math.max(1, Math.ceil(loginHashLimiter.queueTimeoutMs / 1000))
    };
  }

  const isValid = isUsernameMatch && isPasswordMatch;
  if (isValid) resetFailedAttempts(ip);

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
    if (!session) return false;
    request.authSessionToken = token;
    request.authSession = session;
    return true;
  } catch (_) {
    return false;
  }
}

export {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  verifyPasswordAsync,
  HASH_ITERATIONS
};
