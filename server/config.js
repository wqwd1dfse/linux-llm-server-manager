import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration with no hardcoded credentials
const DEFAULT_CONFIG = {
  host: process.env.REMOTE_HOST || '192.168.1.128',
  port: parseInt(process.env.REMOTE_PORT, 10) || 22,
  username: process.env.REMOTE_USER || 'root',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  serverPort: parseInt(process.env.PORT, 10) || 3888,
  serverHost: process.env.HOST || '127.0.0.1',
  metricsInterval: parseInt(process.env.METRICS_INTERVAL, 10) || 2000,
  serverLabel: 'Linux Server (192.168.1.128)',
  enableCustomScripts: process.env.ENABLE_CUSTOM_SCRIPTS === 'true',
  modelRoots: (process.env.MODEL_ROOTS || '/mnt/models,/opt/models').split(',').map(s => s.trim()).filter(Boolean),
  hfToken: process.env.HF_TOKEN || ''
};

// In-memory runtime session config (used when remember=false)
let runtimeSshOverride = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getConfig() {
  ensureDataDir();
  let conf = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      conf = { ...conf, ...parsed };
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
  ensureDataDir();
  let currentFileConfig = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      currentFileConfig = { ...currentFileConfig, ...JSON.parse(raw) };
    } catch (_) {}
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

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error('[Config] Failed to save config.json:', err.message);
  }

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
  const current = getConfig();
  current.hfToken = (token || '').trim();
  saveConfig({ hfToken: current.hfToken });
}
