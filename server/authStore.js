import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from './atomicFile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

const HASH_ITERATIONS = 220000;
const HASH_KEYLEN = 64;
const HASH_DIGEST = 'sha512';
const HASH_ALGO = 'pbkdf2-sha512';
const MAX_HASH_ITERATIONS = 2_000_000;
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 4096;
const UNSAFE_EXAMPLE_PASSWORDS = new Set([
  'your_secure_admin_password_here',
  'your_secure_password_here',
  'change_me',
  'changeme'
]);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function isValidAuthRecord(record) {
  return Boolean(
    record && typeof record === 'object'
    && typeof record.username === 'string'
    && record.username.trim().length > 0
    && record.username.length <= 64
    && !/[\u0000-\u001f\u007f]/.test(record.username)
    && record.algorithm === HASH_ALGO
    && Number.isInteger(Number(record.iterations))
    && Number(record.iterations) >= HASH_ITERATIONS && Number(record.iterations) <= MAX_HASH_ITERATIONS
    && /^[a-f0-9]{32}$/i.test(record.salt || '')
    && /^[a-f0-9]{128}$/i.test(record.hash || '')
  );
}

export function validateAdminPassword(password) {
  if (typeof password !== 'string') return 'ADMIN_PASSWORD must be a string';
  if (password.length < MIN_PASSWORD_LENGTH || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  if (UNSAFE_EXAMPLE_PASSWORDS.has(password.trim().toLowerCase())) {
    return 'ADMIN_PASSWORD is still set to a public example placeholder';
  }
  return null;
}

function validateEnvironmentCredentials(username, password) {
  if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) {
    return 'ADMIN_USERNAME must be 1-64 characters and contain no control characters';
  }
  return validateAdminPassword(password);
}

export function getAuthFilePath() {
  return process.env.AUTH_FILE_PATH || path.join(DATA_DIR, 'auth.json');
}

/**
 * Hash password with PBKDF2-HMAC-SHA512 and 220,000 iterations
 */
export function hashPassword(password, saltHex = null) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
  return {
    algorithm: HASH_ALGO,
    iterations: HASH_ITERATIONS,
    salt,
    hash
  };
}

/**
 * Verify password against stored hash record
 */
export function verifyPassword(password, record) {
  if (!record || record.algorithm !== HASH_ALGO) return false;
  if (!/^[a-f0-9]{32}$/i.test(record.salt || '') || !/^[a-f0-9]{128}$/i.test(record.hash || '')) return false;
  const iterations = Number(record.iterations);
  if (!Number.isInteger(iterations) || iterations < HASH_ITERATIONS || iterations > MAX_HASH_ITERATIONS) return false;
  const passwordText = String(password || '');
  if (Buffer.byteLength(passwordText, 'utf8') > MAX_PASSWORD_BYTES) return false;

  const checkHash = crypto.pbkdf2Sync(passwordText, record.salt, iterations, HASH_KEYLEN, HASH_DIGEST);
  const originalHash = Buffer.from(record.hash, 'hex');

  return originalHash.length === checkHash.length && crypto.timingSafeEqual(checkHash, originalHash);
}

/**
 * Non-blocking password verification for request handlers. PBKDF2 is
 * intentionally expensive, so keeping it off the event loop prevents one
 * login attempt from stalling every dashboard connection.
 */
export function verifyPasswordAsync(password, record) {
  if (!record || record.algorithm !== HASH_ALGO) return Promise.resolve(false);
  if (!/^[a-f0-9]{32}$/i.test(record.salt || '') || !/^[a-f0-9]{128}$/i.test(record.hash || '')) {
    return Promise.resolve(false);
  }
  const iterations = Number(record.iterations);
  if (!Number.isInteger(iterations) || iterations < HASH_ITERATIONS || iterations > MAX_HASH_ITERATIONS) {
    return Promise.resolve(false);
  }
  const passwordText = String(password || '');
  if (Buffer.byteLength(passwordText, 'utf8') > MAX_PASSWORD_BYTES) return Promise.resolve(false);
  const originalHash = Buffer.from(record.hash, 'hex');

  return new Promise((resolve) => {
    crypto.pbkdf2(passwordText, record.salt, iterations, HASH_KEYLEN, HASH_DIGEST, (error, checkHash) => {
      if (error || originalHash.length !== checkHash?.length) {
        resolve(false);
        return;
      }
      resolve(crypto.timingSafeEqual(checkHash, originalHash));
    });
  });
}

/**
 * Load auth credentials from disk or environment
 */
export function loadAuthRecord() {
  const authFile = getAuthFilePath();
  if (fs.existsSync(authFile)) {
    try {
      const content = fs.readFileSync(authFile, 'utf-8');
      const data = JSON.parse(content);
      if (isValidAuthRecord(data)) return data;
      console.error('[AuthStore] Auth file has an invalid schema; refusing to overwrite it automatically.');
      return null;
    } catch (err) {
      console.error('[AuthStore] Failed to read auth file:', err.message);
      return null;
    }
  }

  // Fallback to environment variable ADMIN_PASSWORD if provided
  if (process.env.ADMIN_PASSWORD) {
    const username = (process.env.ADMIN_USERNAME || 'admin').trim();
    const password = process.env.ADMIN_PASSWORD;
    const validationError = validateEnvironmentCredentials(username, password);
    if (validationError) {
      console.error(`[AuthStore] Refusing unsafe environment credentials: ${validationError}. Complete setup in the dashboard or provide a strong unique password.`);
      return null;
    }
    const record = {
      username,
      ...hashPassword(password)
    };
    saveAuthRecord(record);
    return record;
  }

  return null;
}

/**
 * Save auth record atomically with temporary file, fsync, and rename
 */
export function saveAuthRecord(record) {
  if (!isValidAuthRecord(record)) {
    throw new Error('Invalid auth record');
  }

  const authFile = getAuthFilePath();
  const dir = path.dirname(authFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  writeJsonAtomic(authFile, record, { encoding: 'utf8', mode: 0o600 });

  return true;
}

export function isAuthInitialized() {
  return loadAuthRecord() !== null;
}

export { HASH_ITERATIONS };
