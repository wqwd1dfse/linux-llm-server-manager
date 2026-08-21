import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { writeJsonAtomic } from './atomicFile.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function parseBoundedInteger(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseConfigJson(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.json must contain a JSON object');
  }
  return parsed;
}

export function getConfigFilePath() {
  return process.env.CONFIG_FILE_PATH || DEFAULT_CONFIG_PATH;
}

const defaultRemoteHost = String(process.env.REMOTE_HOST || '192.168.1.128').trim();

// Default configuration with no hardcoded credentials
const DEFAULT_CONFIG = {
  host: defaultRemoteHost,
  port: parseBoundedInteger(process.env.REMOTE_PORT, 22, 1, 65535),
  username: process.env.REMOTE_USER || 'root',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  serverPort: parseBoundedInteger(process.env.PORT, 3888, 1, 65535),
  serverHost: process.env.HOST || '127.0.0.1',
  metricsInterval: parseBoundedInteger(process.env.METRICS_INTERVAL, 2000, 500, 60000),
  serverLabel: `Linux Server (${defaultRemoteHost})`,
  enableCustomScripts: process.env.ENABLE_CUSTOM_SCRIPTS === 'true',
  modelRoots: (process.env.MODEL_ROOTS || '/mnt/models,/opt/models').split(',').map(s => s.trim()).filter(Boolean),
  hfToken: process.env.HF_TOKEN || ''
};

// In-memory runtime session config (used when remember=false)
let runtimeSshOverride = null;

function ensureDataDir(configPath = getConfigFilePath()) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

export function getConfig() {
  const configPath = getConfigFilePath();
  ensureDataDir(configPath);
  let conf = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      conf = { ...conf, ...parseConfigJson(raw) };
    } catch (err) {
      console.error('[Config] Error reading config.json:', err.message);
    }
  }

  // Apply in-memory runtime overrides if set
  if (runtimeSshOverride) {
    conf = { ...conf, ...runtimeSshOverride };
  }

  return conf;
}

export function setRuntimeSshOverride(override) {
  runtimeSshOverride = override ? { ...override } : null;
}

export function saveConfig(updates) {
  const configPath = getConfigFilePath();
  ensureDataDir(configPath);
  let currentFileConfig = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      currentFileConfig = { ...currentFileConfig, ...parseConfigJson(raw) };
    } catch (error) {
      throw new Error(`现有配置文件无法解析，已停止覆盖: ${error.message}`);
    }
  }

  const cleanUpdates = { ...updates };
  // Never save empty strings as password overwrite if undefined
  if (cleanUpdates.password === undefined) {
    delete cleanUpdates.password;
  }
  if (cleanUpdates.privateKey === undefined) {
    delete cleanUpdates.privateKey;
  }
  if (cleanUpdates.passphrase === undefined) {
    delete cleanUpdates.passphrase;
  }

  const updated = { ...currentFileConfig, ...cleanUpdates };
  // Remove runtime fields before saving to disk
  delete updated.serverHost;
  delete updated.enableCustomScripts;
  delete updated.modelRoots;

  writeJsonAtomic(configPath, updated, { encoding: 'utf8', mode: 0o600 });

  // Clear runtime override since it was persisted
  runtimeSshOverride = null;
  return getConfig();
}

export function getSafeConfig() {
  const cfg = getConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    authType: cfg.authType,
    activeProfileId: cfg.activeProfileId || null,
    serverPort: cfg.serverPort,
    serverHost: cfg.serverHost,
    serverLabel: cfg.serverLabel,
    metricsInterval: cfg.metricsInterval,
    enableCustomScripts: Boolean(cfg.enableCustomScripts),
    modelRoots: cfg.modelRoots,
    hasPassword: Boolean(cfg.password && cfg.password.length > 0),
    hasPrivateKey: Boolean(cfg.privateKey && cfg.privateKey.length > 0),
    hasHfToken: Boolean(cfg.hfToken && cfg.hfToken.length > 0)
  };
}

export function updateHfToken(token) {
  saveConfig({ hfToken: (token || '').trim() });
}
