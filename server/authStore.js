import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

const HASH_ITERATIONS = 220000;
const HASH_KEYLEN = 64;
const HASH_DIGEST = 'sha512';
const HASH_ALGO = 'pbkdf2-sha512';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
  if (!record || !record.salt || !record.hash) return false;
  const iterations = record.iterations || HASH_ITERATIONS;
  const digest = record.algorithm === HASH_ALGO ? HASH_DIGEST : 'sha512';

  const checkHash = crypto.pbkdf2Sync(password, record.salt, iterations, HASH_KEYLEN, digest).toString('hex');
  const bufCheck = Buffer.from(checkHash, 'utf-8');
  const bufOrig = Buffer.from(record.hash, 'utf-8');

  if (bufCheck.length !== bufOrig.length) return false;
  return crypto.timingSafeEqual(bufCheck, bufOrig);
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
      if (data && data.username && data.hash && data.salt) {
        return data;
      }
    } catch (err) {
      console.error('[AuthStore] Failed to read auth file:', err.message);
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
  if (!record || !record.username || !record.hash || !record.salt) {
    throw new Error('Invalid auth record');
  }

  const authFile = getAuthFilePath();
  const dir = path.dirname(authFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpFile = path.join(dir, `auth.tmp.${process.pid}.${Date.now()}`);
  const payload = JSON.stringify(record, null, 2);

  const fd = fs.openSync(tmpFile, 'w', 0o600);
  try {
    fs.writeFileSync(fd, payload, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpFile, authFile);
  try {
    fs.chmodSync(authFile, 0o600);
  } catch (_) {}

  return true;
}

export function isAuthInitialized() {
  return loadAuthRecord() !== null;
}

export { HASH_ITERATIONS };
