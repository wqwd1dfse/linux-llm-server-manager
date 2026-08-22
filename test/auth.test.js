import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAsync,
  createSession,
  getSession,
  destroySession,
  onSessionInvalidated,
  signCookie,
  unsignCookie,
  parseCookies,
  recordFailedAttempt,
  resetFailedAttempts,
  checkRateLimit,
  HASH_ITERATIONS
} from '../server/auth.js';

test('Auth: Password hashing with PBKDF2 salt (>= 220000 iterations)', () => {
  assert.equal(HASH_ITERATIONS >= 220000, true);
  const record = hashPassword('MySecretPass123!');
  assert.equal(record.algorithm, 'pbkdf2-sha512');
  assert.equal(record.iterations, 220000);
  assert.equal(record.salt.length, 32);
  assert.equal(record.hash.length, 128);

  assert.equal(verifyPassword('MySecretPass123!', record), true);
  assert.equal(verifyPassword('WrongPass', record), false);
});

test('Auth: request-path PBKDF2 verification is asynchronous', async () => {
  const record = hashPassword('AsyncSecretPass123!');
  let immediateRan = false;
  const verification = verifyPasswordAsync('AsyncSecretPass123!', record);
  setImmediate(() => { immediateRan = true; });
  assert.equal(await verification, true);
  assert.equal(immediateRan, true);
  assert.equal(await verifyPasswordAsync('WrongPass', record), false);
});

test('Auth: Cookie signing and unsigning with HMAC-SHA256', () => {
  const token = 'session_test_token_abc123';
  const signed = signCookie(token);

  assert.match(signed, /^s:session_test_token_abc123\.[A-Za-z0-9+/=_-]+$/);
  assert.equal(unsignCookie(signed), token);

  // Tampered cookie returns null
  const tampered = signed.slice(0, -4) + 'abcd';
  assert.equal(unsignCookie(tampered), null);
  assert.equal(unsignCookie('invalid_cookie'), null);
});

test('Auth: Cookie header parser', () => {
  const parsed = parseCookies('agm_session=s%3Atoken.sig; win-theme=dark; other=value');
  assert.equal(parsed['agm_session'], 's:token.sig');
  assert.equal(parsed['win-theme'], 'dark');
  assert.equal(parsed['other'], 'value');
});

test('Auth: Session lifecycle and expiry', () => {
  const token = createSession({ username: 'admin', role: 'root' });
  assert.ok(token);

  const session = getSession(token);
  assert.ok(session);
  assert.equal(session.user.username, 'admin');

  destroySession(token);
  assert.equal(getSession(token), null);
});

test('Auth: destroying a session notifies live transports exactly once', () => {
  const invalidated = [];
  const unsubscribe = onSessionInvalidated((token) => invalidated.push(token));
  const token = createSession({ username: 'admin' });

  destroySession(token);
  destroySession(token);
  unsubscribe();

  assert.deepEqual(invalidated, [token]);
});

test('Auth: Rate limiting brute-force defense', () => {
  const testIp = '198.51.100.99';

  assert.equal(checkRateLimit(testIp).allowed, true);
  recordFailedAttempt(testIp);
  recordFailedAttempt(testIp);
  recordFailedAttempt(testIp);
  recordFailedAttempt(testIp);
  assert.equal(checkRateLimit(testIp).allowed, true);

  // 5th failed attempt locks out
  recordFailedAttempt(testIp);
  assert.equal(checkRateLimit(testIp).allowed, false);

  resetFailedAttempts(testIp);
  assert.equal(checkRateLimit(testIp).allowed, true);
});
