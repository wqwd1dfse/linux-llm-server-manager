import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(here, '..', 'data', 'auth.http.test.json');
process.env.AUTH_FILE_PATH = authFile;
process.env.AUTO_CONNECT = 'false';
process.env.MAX_TERMINAL_WEBSOCKETS = '1';
delete process.env.ADMIN_PASSWORD;

if (fs.existsSync(authFile)) fs.unlinkSync(authFile);

const { server } = await import('../server/index.js');
const { loginHashLimiter } = await import('../server/auth.js');

function request(port, method, requestPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {}),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : null
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('HTTP auth flow protects APIs and invalidates logout sessions', async (t) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
  });

  const port = server.address().port;
  const initial = await request(port, 'GET', '/api/auth/status');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.needsSetup, true);

  const unauthenticated = await request(port, 'GET', '/api/auth/profiles');
  assert.equal(unauthenticated.status, 401);

  const proxiedSetup = await request(port, 'POST', '/api/auth/setup', {
    username: 'remote-admin',
    password: 'RemoteSetupMustBeRejected2026!'
  }, { 'X-Forwarded-For': '203.0.113.10' });
  assert.equal(proxiedSetup.status, 403);

  const setup = await request(port, 'POST', '/api/auth/setup', {
    username: 'http-admin',
    password: 'HttpIntegrationPassword2026!'
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  const authenticatedStatus = await request(port, 'GET', '/api/auth/status', null, { Cookie: cookie });
  const targetEpoch = authenticatedStatus.body.status.targetEpoch;
  assert.match(targetEpoch, /^[A-Za-z0-9_-]+\.\d+$/);

  // Occupy both the active worker allowance and the bounded queue so this
  // exercises the HTTP overload contract without relying on PBKDF2 timing.
  const activeHashSlots = await Promise.all(
    Array.from({ length: loginHashLimiter.limit }, () => loginHashLimiter.acquire())
  );
  const queuedHashSlots = Array.from(
    { length: loginHashLimiter.maxQueue },
    () => loginHashLimiter.acquire().then((release) => release())
  );
  try {
    const busyLogin = await request(port, 'POST', '/api/auth/login', {
      username: 'http-admin',
      password: 'HttpIntegrationPassword2026!'
    });
    assert.equal(busyLogin.status, 503);
    assert.equal(busyLogin.body.code, 'AUTH_BUSY');
    assert.match(busyLogin.body.error, /登录服务繁忙/);
    assert.equal(Number(busyLogin.headers['retry-after']) >= 1, true);
  } finally {
    for (const release of activeHashSlots) release();
    await Promise.all(queuedHashSlots);
  }

  const missingEpoch = await request(port, 'GET', '/api/auth/profiles', null, { Cookie: cookie });
  assert.equal(missingEpoch.status, 428);
  assert.equal(missingEpoch.body.code, 'SSH_TARGET_EPOCH_REQUIRED');

  const staleEpoch = await request(port, 'GET', '/api/auth/profiles', null, {
    Cookie: cookie,
    'X-SSH-Target-Epoch': `${targetEpoch}-stale`
  });
  assert.equal(staleEpoch.status, 409);
  assert.equal(staleEpoch.body.code, 'SSH_TARGET_STALE');
  assert.equal(staleEpoch.body.targetEpoch, targetEpoch);

  const authenticated = await request(port, 'GET', '/api/auth/profiles', null, {
    Cookie: cookie,
    'X-SSH-Target-Epoch': targetEpoch
  });
  assert.equal(authenticated.status, 200);
  assert.ok(Array.isArray(authenticated.body.profiles));

  await new Promise((resolve, reject) => {
    const missingEpochSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }
    });
    missingEpochSocket.once('unexpected-response', (_request, response) => {
      try {
        assert.equal(response.statusCode, 428);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    missingEpochSocket.once('open', () => reject(new Error('Target epoch was not required for WebSocket upgrade')));
    missingEpochSocket.on('error', () => {});
  });

  const encodedEpoch = encodeURIComponent(targetEpoch);
  const terminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?targetEpoch=${encodedEpoch}`, {
    headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }
  });
  await once(terminalSocket, 'open');
  await new Promise((resolve, reject) => {
    const extraSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?targetEpoch=${encodedEpoch}`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }
    });
    extraSocket.once('unexpected-response', (_request, response) => {
      try {
        assert.equal(response.statusCode, 503);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    extraSocket.once('open', () => reject(new Error('Terminal WebSocket limit was not enforced')));
    extraSocket.on('error', () => {});
  });
  terminalSocket.close();
  await once(terminalSocket, 'close');

  const metricsSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/metrics?targetEpoch=${encodedEpoch}`, {
    headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }
  });
  await once(metricsSocket, 'open');
  const socketClosed = once(metricsSocket, 'close');

  const logout = await request(port, 'POST', '/api/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.status, 200);
  await socketClosed;

  const afterLogout = await request(port, 'GET', '/api/auth/profiles', null, { Cookie: cookie });
  assert.equal(afterLogout.status, 401);
});
