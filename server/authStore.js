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

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function isValidAuthRecord(record) {
  return Boolean(
    record && typeof record === 'object'
    && typeof record.username === 'string' && record.username.trim().length > 0 && record.username.length <= 64
    && record.algorithm === HASH_ALGO
    && Number.isInteger(Number(record.iterations))
    && Number(record.iterations) >= HASH_ITERATIONS && Number(record.iterations) <= MAX_HASH_ITERATIONS
    && /^[a-f0-9]{32}$/i.test(record.salt || '')
    && /^[a-f0-9]{128}$/i.test(record.hash || '')
  );
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

  const checkHash = crypto.pbkdf2Sync(String(password || ''), record.salt, iterations, HASH_KEYLEN, HASH_DIGEST);
  const originalHash = Buffer.from(record.hash, 'hex');

  return originalHash.length === checkHash.length && crypto.timingSafeEqual(checkHash, originalHash);
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
    const record = {
      username,
      ...hashPassword(process.env.ADMIN_PASSWORD)
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
