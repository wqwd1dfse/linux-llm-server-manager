import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(here, '..', 'data', 'auth.http.test.json');
process.env.AUTH_FILE_PATH = authFile;
process.env.AUTO_CONNECT = 'false';

if (fs.existsSync(authFile)) fs.unlinkSync(authFile);

const { server } = await import('../server/index.js');

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

  const authenticated = await request(port, 'GET', '/api/auth/profiles', null, { Cookie: cookie });
  assert.equal(authenticated.status, 200);
  assert.ok(Array.isArray(authenticated.body.profiles));

  const logout = await request(port, 'POST', '/api/auth/logout', {}, { Cookie: cookie });
  assert.equal(logout.status, 200);

  const afterLogout = await request(port, 'GET', '/api/auth/profiles', null, { Cookie: cookie });
  assert.equal(afterLogout.status, 401);
});
