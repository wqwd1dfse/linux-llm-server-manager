import test from 'node:test';
import assert from 'node:assert/strict';
import { applySecurityHeaders, verifyWebSocketOrigin } from '../server/securityHeaders.js';

test('SecurityHeaders: HTTP Security middleware', () => {
  const headers = {};
  const mockReq = { headers: {} };
  const mockRes = {
    setHeader(k, v) { headers[k] = v; }
  };
  let nextCalled = false;

  applySecurityHeaders(mockReq, mockRes, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.ok(headers['Content-Security-Policy'].includes("default-src 'self'"));
  const csp = headers['Content-Security-Policy'];
  const scriptDirective = csp.split(';').find((part) => part.trim().startsWith('script-src '));
  assert.ok(csp.includes("script-src-attr 'none'"));
  assert.ok(csp.includes("object-src 'none'"));
  assert.equal(scriptDirective.includes("'unsafe-inline'"), false);
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('SecurityHeaders: authenticated API data is never cacheable', () => {
  const headers = {};
  const req = { path: '/api/system/metrics', method: 'GET', headers: {}, secure: false };
  const res = { setHeader: (name, value) => { headers[name] = value; } };
  let nextCalled = false;
  applySecurityHeaders(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(headers.Pragma, 'no-cache');
});

test('SecurityHeaders: WebSocket Origin verification', () => {
  // Allow empty origin (direct tool / CLI)
  assert.equal(verifyWebSocketOrigin({ headers: {} }), true);

  // Allow same-origin matching host
  assert.equal(verifyWebSocketOrigin({
    headers: { origin: 'http://127.0.0.1:3888', host: '127.0.0.1:3888' }
  }), true);

  // Allow localhost
  assert.equal(verifyWebSocketOrigin({
    headers: { origin: 'http://localhost:3888', host: 'localhost:3888' }
  }), true);

  // Reject malicious cross-origin
  assert.equal(verifyWebSocketOrigin({
    headers: { origin: 'http://malicious-hacker.com', host: '127.0.0.1:3888' }
  }), false);

  // Browser WebSocket origins are HTTP(S); matching hosts on other schemes
  // must not bypass the origin policy.
  assert.equal(verifyWebSocketOrigin({
    headers: { origin: 'ftp://127.0.0.1:3888', host: '127.0.0.1:3888' }
  }), false);
});

test('SecurityHeaders: unsafe API requests reject cross-site browser origins', () => {
  let statusCode = 200;
  let responseBody = null;
  let nextCalled = false;
  const req = {
    method: 'POST',
    path: '/api/docker/images/delete',
    secure: false,
    headers: { origin: 'https://evil.example', host: 'manager.example' }
  };
  const res = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return this; },
    end() {}
  };

  applySecurityHeaders(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.equal(responseBody.success, false);
});
