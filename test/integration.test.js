import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  hashPassword,
  verifyPassword,
  saveAuthRecord,
  loadAuthRecord,
  isAuthInitialized,
  HASH_ITERATIONS
} from '../server/authStore.js';

import {
  authenticateUser,
  checkRateLimit,
  createLoginHashLimiter,
  createSession,
  getSession,
  destroySession,
  signCookie,
  unsignCookie,
  authMiddleware,
  authenticateWebSocketRequest,
  setInitialPassword,
  resetFailedAttempts,
  SESSION_COOKIE_NAME
} from '../server/auth.js';

import {
  executeCommand
} from '../server/sshManager.js';

import {
  buildSafeCommand,
  validateSafePath,
  validatePort,
  validateSignal,
  validatePid,
  validateServiceName,
  validateSystemdAction
} from '../server/executor.js';

import {
  verifyWebSocketOrigin,
  applySecurityHeaders
} from '../server/securityHeaders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.test.json');
process.env.AUTH_FILE_PATH = TEST_AUTH_FILE;

after(() => {
  if (fs.existsSync(TEST_AUTH_FILE)) {
    try { fs.unlinkSync(TEST_AUTH_FILE); } catch (_) {}
  }
});

test('1. Auth Persistence & 220,000 Iteration PBKDF2-SHA512', () => {
  assert.equal(HASH_ITERATIONS >= 220000, true, 'Hash iterations must be >= 220,000');

  const password = 'SuperSecretAdminPassword123!';
  const record = {
    username: 'admin',
    ...hashPassword(password)
  };

  assert.equal(record.algorithm, 'pbkdf2-sha512');
  assert.equal(record.iterations, 220000);
  assert.equal(typeof record.salt, 'string');
  assert.equal(record.salt.length, 32);
  assert.equal(record.hash.length, 128);

  // Verify correct password
  assert.equal(verifyPassword(password, record), true);
  // Verify wrong password fails
  assert.equal(verifyPassword('WrongPassword!', record), false);

  // Test atomic persistence to disk
  saveAuthRecord(record);
  assert.equal(fs.existsSync(TEST_AUTH_FILE), true);

  // Reload from disk (simulating server restart)
  const loaded = loadAuthRecord();
  assert.notEqual(loaded, null);
  assert.equal(loaded.username, 'admin');
  assert.equal(loaded.iterations, 220000);
  assert.equal(verifyPassword(password, loaded), true);
});

test('2. Username & Password Real Validation in authenticateUser', async () => {
  const password = 'AdminPasswordValid2026';
  setInitialPassword(password, 'sysadmin');
  assert.throws(() => setInitialPassword('Short123', 'sysadmin'), /至少需要 12 个字符/);
  assert.throws(
    () => setInitialPassword('your_secure_admin_password_here', 'sysadmin'),
    /public example placeholder/
  );

  // Case A: Correct username + Correct password
  const resSuccess = await authenticateUser('sysadmin', password, '127.0.0.1');
  assert.equal(resSuccess.success, true);
  assert.equal(resSuccess.username, 'sysadmin');
  assert.equal(typeof resSuccess.token, 'string');

  // Case B: Wrong username + Correct password -> MUST FAIL
  const resWrongUser = await authenticateUser('admin', password, '127.0.0.1');
  assert.equal(resWrongUser.success, false);
  assert.equal(resWrongUser.error, '用户名或密码错误');

  // Case C: Correct username + Wrong password -> MUST FAIL
  const resWrongPass = await authenticateUser('sysadmin', 'WrongPass', '127.0.0.1');
  assert.equal(resWrongPass.success, false);
  assert.equal(resWrongPass.error, '用户名或密码错误');
});

test('2b. Concurrent login bursts cannot outrun the rate limiter', async () => {
  const ip = '198.51.100.77';
  resetFailedAttempts(ip);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => authenticateUser('sysadmin', 'WrongPass', ip))
  );
  assert.equal(results.some((result) => /登录尝试过多/.test(result.error || '')), true);
  assert.equal(checkRateLimit(ip).allowed, false);
  resetFailedAttempts(ip);
});

test('2c. Login hash backpressure configuration is strictly bounded', () => {
  const defaults = createLoginHashLimiter({});
  assert.equal(defaults.limit, 4);
  assert.equal(defaults.maxQueue, 32);
  assert.equal(defaults.queueTimeoutMs, 2_000);

  const maximums = createLoginHashLimiter({
    MAX_CONCURRENT_LOGIN_HASHES: '32',
    MAX_QUEUED_LOGIN_HASHES: '256',
    LOGIN_HASH_QUEUE_TIMEOUT_MS: '30000'
  });
  assert.equal(maximums.limit, 32);
  assert.equal(maximums.maxQueue, 256);
  assert.equal(maximums.queueTimeoutMs, 30_000);

  const invalid = createLoginHashLimiter({
    MAX_CONCURRENT_LOGIN_HASHES: '0',
    MAX_QUEUED_LOGIN_HASHES: '257',
    LOGIN_HASH_QUEUE_TIMEOUT_MS: '99'
  });
  assert.equal(invalid.limit, 4);
  assert.equal(invalid.maxQueue, 32);
  assert.equal(invalid.queueTimeoutMs, 2_000);
});

test('3. API Authentication Middleware & Public Endpoints Whitelist', () => {
  // Test A: Public endpoints are allowed without cookie
  const publicPaths = ['/api/auth/status', '/api/auth/login', '/api/auth/setup'];
  for (const path of publicPaths) {
    let nextCalled = false;
    const req = { originalUrl: path, headers: {} };
    const res = {
      status: () => ({ json: () => {} })
    };
    authMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `Path ${path} should be accessible publicly`);
  }

  // Test B: Protected endpoints blocked with 401 when unauthenticated
  const protectedPaths = [
    '/api/auth/connect',
    '/api/auth/disconnect',
    '/api/system/metrics',
    '/api/files/list',
    '/api/files/delete',
    '/api/docker/containers',
    '/api/services/systemd',
    '/api/llm/start',
    '/api/fan/manual',
    '/api/scripts/run'
  ];

  for (const path of protectedPaths) {
    let statusCode = null;
    let jsonBody = null;
    const req = { originalUrl: path, headers: {} };
    const res = {
      status: (code) => {
        statusCode = code;
        return {
          json: (body) => { jsonBody = body; }
        };
      }
    };
    authMiddleware(req, res, () => { assert.fail(`Should not call next for unauthenticated ${path}`); });
    assert.equal(statusCode, 401, `Path ${path} must require authentication`);
    assert.equal(jsonBody?.code, 'UNAUTHORIZED');
  }
});

test('4. Session Lifecycle: Expiry, Tampering, Logout', () => {
  const token = createSession({ username: 'admin' });
  const signed = signCookie(token);

  // Authenticated access with valid signed cookie
  let authed = false;
  let req = { originalUrl: '/api/files/list', headers: { cookie: `${SESSION_COOKIE_NAME}=${signed}` } };
  const res = { status: () => ({ json: () => {} }) };
  authMiddleware(req, res, () => { authed = true; });
  assert.equal(authed, true, 'Valid signed session cookie must authenticate');

  // Tampered cookie -> 401
  const tamperedSigned = signed.slice(0, -4) + 'abcd';
  let tamperedAuthed = false;
  let tamperedStatus = null;
  req = { originalUrl: '/api/files/list', headers: { cookie: `${SESSION_COOKIE_NAME}=${tamperedSigned}` } };
  const resTampered = { status: (code) => { tamperedStatus = code; return { json: () => {} }; } };
  authMiddleware(req, resTampered, () => { tamperedAuthed = true; });
  assert.equal(tamperedAuthed, false);
  assert.equal(tamperedStatus, 401);

  // Destroy session (Logout) -> 401
  destroySession(token);
  assert.equal(getSession(token), null);
  let postLogoutAuthed = false;
  let postLogoutStatus = null;
  req = { originalUrl: '/api/files/list', headers: { cookie: `${SESSION_COOKIE_NAME}=${signed}` } };
  const resLogout = { status: (code) => { postLogoutStatus = code; return { json: () => {} }; } };
  authMiddleware(req, resLogout, () => { postLogoutAuthed = true; });
  assert.equal(postLogoutAuthed, false);
  assert.equal(postLogoutStatus, 401);
});

test('5. WebSocket Upgrade Authentication & Origin Verification', () => {
  // Test A: Origin check
  assert.equal(verifyWebSocketOrigin({ headers: { host: '127.0.0.1:3888', origin: 'http://127.0.0.1:3888' } }), true);
  assert.equal(verifyWebSocketOrigin({ headers: { host: '127.0.0.1:3888', origin: 'http://evil-attacker.com' } }), false);

  // Test B: Unauthenticated WS Upgrade
  assert.equal(authenticateWebSocketRequest({ headers: {} }), false);

  // Test C: Valid session WS Upgrade
  const token = createSession({ username: 'admin' });
  const signed = signCookie(token);
  assert.equal(authenticateWebSocketRequest({ headers: { cookie: `${SESSION_COOKIE_NAME}=${signed}` } }), true);

  // Test D: After logout WS Upgrade
  destroySession(token);
  assert.equal(authenticateWebSocketRequest({ headers: { cookie: `${SESSION_COOKIE_NAME}=${signed}` } }), false);
});

test('6. Unified Executor: Strictly requires (executable, argv[])', async () => {
  // Array args -> Safe command builder
  const cmd = buildSafeCommand('systemctl', ['restart', 'nginx; touch /tmp/pwned']);
  assert.equal(cmd, "systemctl restart 'nginx; touch /tmp/pwned'");

  // Non-array call -> executeCommand must reject
  await assert.rejects(
    async () => {
      await executeCommand('echo', 'not-an-array');
    },
    /argv must be an Array/
  );

  // Command string with spaces as executable -> buildSafeCommand must reject
  assert.throws(
    () => {
      buildSafeCommand('echo hello world', []);
    },
    /Invalid executable name/
  );
});

test('7. LLM Parameter & Path Traversal Injection Prevention', () => {
  // Safe path validation
  assert.throws(() => validateSafePath('../../etc/shadow'), /路径必须为绝对路径/);
  assert.throws(() => validateSafePath('relative/model.gguf'), /路径必须为绝对路径/);
  assert.throws(() => validateSafePath('/root/model\0.gguf'), /Null byte/);

  // Port validation
  assert.equal(validatePort(8080), 8080);
  assert.throws(() => validatePort(99999), /非法端口号/);
  assert.throws(() => validatePort('8080; reboot'), /非法端口号/);

  // PID and signal validation
  assert.equal(validatePid(1234), 1234);
  assert.throws(() => validatePid('1234; rm -rf /'), /非法进程 PID/);

  assert.equal(validateSignal('9'), '9');
  assert.throws(() => validateSignal('KILL; id'), /非法信号/);

  // Service name validation
  assert.equal(validateServiceName('nginx'), 'nginx.service');
  assert.throws(() => validateServiceName('nginx; rm -rf /'), /非法服务名称/);
  assert.equal(validateSystemdAction('restart'), 'restart');
  assert.throws(() => validateSystemdAction('reboot'), /非法 Systemd 指令/);
});
