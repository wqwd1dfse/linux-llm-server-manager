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
});
