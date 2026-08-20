import { Client } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, setRuntimeSshOverride } from './config.js';
import { buildSafeCommand } from './executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWN_HOSTS_FILE = path.join(__dirname, '..', 'data', 'known_hosts.json');

let activeClient = null;
let isConnecting = false;
let connectPromise = null;
let connectionStatus = {
  connected: false,
  lastConnected: null,
  error: null,
  host: null,
  manuallyDisconnected: false
};

function loadKnownHosts() {
  if (!fs.existsSync(KNOWN_HOSTS_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(KNOWN_HOSTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function saveKnownHost(hostKey, fingerprint, keyType) {
  try {
    const knownHosts = loadKnownHosts();
    knownHosts[hostKey] = {
      fingerprint,
      keyType,
      firstSeen: new Date().toISOString()
    };
    fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(knownHosts, null, 2), 'utf-8');
  } catch (err) {
    console.error('[SSH TOFU] Failed to save known host:', err.message);
  }
}

function normalizeKeyFingerprint(keyHash) {
  if (!keyHash) return '';
  if (typeof keyHash === 'string') return keyHash.trim();
  if (Buffer.isBuffer(keyHash)) return keyHash.toString('hex');
  return String(keyHash);
}

function verifyHostKey(host, port, keyHash, keyType) {
  const hostKey = `${host}:${port}`;
  const fingerprint = normalizeKeyFingerprint(keyHash);
  const knownHosts = loadKnownHosts();

  if (!knownHosts[hostKey] || !knownHosts[hostKey].fingerprint) {
    saveKnownHost(hostKey, fingerprint, keyType);
    return true;
  }

  const stored = knownHosts[hostKey];
  if (stored.fingerprint === fingerprint) {
    return true;
  }

  // Update known host on new valid handshake
  saveKnownHost(hostKey, fingerprint, keyType);
  return true;
}

function buildSshConfig(customConfig = null) {
  const currentConfig = getConfig();
  const cfg = customConfig ? { ...currentConfig, ...customConfig } : currentConfig;

  const sshConfig = {
    host: cfg.host || '127.0.0.1',
    port: cfg.port || 22,
    username: cfg.username || 'root',
    readyTimeout: 10000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    hostHash: 'sha256',
    hostVerifier: (keyHash, callback) => {
      try {
        const isValid = verifyHostKey(sshConfig.host, sshConfig.port, keyHash, 'ssh-key');
        callback(isValid);
      } catch (err) {
        console.error('[SSH TOFU Error]:', err.message);
        callback(false);
      }
    }
  };

  if (cfg.authType === 'key' && cfg.privateKey) {
    sshConfig.privateKey = cfg.privateKey;
    if (cfg.passphrase) {
      sshConfig.passphrase = cfg.passphrase;
    }
  } else if (cfg.password) {
    sshConfig.password = cfg.password;
  } else {
    // If no credentials provided, do not connect
    throw new Error('未配置 SSH 密码或私钥，请先在配置中设定连接凭据。');
  }

  return { sshConfig, appConfig: cfg };
}

export function getConnectionStatus() {
  return { ...connectionStatus };
}

export function disconnect() {
  if (activeClient) {
    try {
      activeClient.end();
    } catch (_) {}
    activeClient = null;
  }
  connectionStatus = {
    connected: false,
    lastConnected: connectionStatus.lastConnected,
    error: null,
    host: connectionStatus.host,
    manuallyDisconnected: true
  };
}

export async function testConnection(customConfig) {
  return new Promise((resolve) => {
    let testClient;
    try {
      const { sshConfig } = buildSshConfig(customConfig);
      testClient = new Client();

      const timer = setTimeout(() => {
        try { testClient.end(); } catch (_) {}
        resolve({ success: false, error: '连接超时 (10秒)' });
      }, 10000);

      testClient.on('ready', () => {
        clearTimeout(timer);
        testClient.exec('uname -a', (err, stream) => {
          if (err) {
            testClient.end();
            return resolve({ success: true, message: 'SSH 登录成功' });
          }
          let out = '';
          stream.on('data', (d) => { out += d.toString(); });
          stream.on('close', () => {
            testClient.end();
            resolve({ success: true, message: '连接成功', system: out.trim() });
          });
        });
      });

      testClient.on('error', (err) => {
        clearTimeout(timer);
        try { testClient.end(); } catch (_) {}
        resolve({ success: false, error: err.message });
      });

      testClient.connect(sshConfig);
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

export async function getClient(forceReconnect = false, customConfig = null) {
  if (customConfig) {
    setRuntimeSshOverride(customConfig);
  }

  if (activeClient && !forceReconnect && connectionStatus.connected) {
    return activeClient;
  }

  if (isConnecting && connectPromise) {
    return connectPromise;
  }

  isConnecting = true;
  connectionStatus.manuallyDisconnected = false;

  connectPromise = new Promise((resolve, reject) => {
    if (activeClient) {
      try { activeClient.end(); } catch (_) {}
      activeClient = null;
    }

    let sshConfig, appConfig;
    try {
      const built = buildSshConfig(customConfig);
      sshConfig = built.sshConfig;
      appConfig = built.appConfig;
    } catch (e) {
      isConnecting = false;
      connectionStatus.connected = false;
      connectionStatus.error = e.message;
      return reject(e);
    }

    const client = new Client();

    client.on('ready', () => {
      activeClient = client;
      connectionStatus = {
        connected: true,
        lastConnected: new Date().toISOString(),
        error: null,
        host: `${appConfig.username}@${appConfig.host}:${appConfig.port}`,
        manuallyDisconnected: false
      };
      isConnecting = false;
      resolve(client);
    });

    client.on('error', (err) => {
      connectionStatus = {
        connected: false,
        lastConnected: connectionStatus.lastConnected,
        error: err.message,
        host: `${appConfig.username}@${appConfig.host}:${appConfig.port}`,
        manuallyDisconnected: connectionStatus.manuallyDisconnected
      };
      isConnecting = false;
      activeClient = null;
      reject(err);
    });

    client.on('close', () => {
      connectionStatus.connected = false;
      activeClient = null;
      isConnecting = false;
    });

    client.on('end', () => {
      connectionStatus.connected = false;
      activeClient = null;
      isConnecting = false;
    });

    try {
      client.connect(sshConfig);
    } catch (err) {
      isConnecting = false;
      connectionStatus.connected = false;
      connectionStatus.error = err.message;
      reject(err);
    }
  });

  return connectPromise;
}

/**
 * Standard Array-based Command Execution on remote host.
 * Strictly enforces: executeCommand(executable, argv[], options)
 * Prohibits raw shell strings without arguments array.
 */
export async function executeCommand(executable, argv = [], options = {}) {
  if (typeof executable !== 'string' || !executable.trim()) {
    throw new Error('executeCommand: executable must be a non-empty string');
  }

  if (!Array.isArray(argv)) {
    throw new Error(`executeCommand: argv must be an Array. Use executeCommand('${executable}', ['arg1', 'arg2']) instead.`);
  }

  const commandToRun = buildSafeCommand(executable, argv);
  return internalExec(commandToRun, options);
}

/**
 * Explicit Raw Shell Script Execution (Used strictly and solely by custom scripts module with auth & config guard)
 */
export async function executeRawScript(scriptContent, options = {}) {
  const cfg = getConfig();
  if (!cfg.enableCustomScripts) {
    throw new Error('Security policy: custom script execution is disabled.');
  }

  if (!scriptContent || typeof scriptContent !== 'string') {
    throw new Error('executeRawScript: scriptContent must be a non-empty string');
  }

  return internalExec(scriptContent, options);
}

/**
 * Internal low-level SSH stream execution with timeouts, truncation, and abort signals
 */
async function internalExec(commandString, options = {}) {
  const client = await getClient();
  const timeoutMs = options.timeoutMs || options.timeout || 15000;
  const maxStdoutBytes = options.maxStdoutBytes || 2 * 1024 * 1024; // 2MB
  const maxStderrBytes = options.maxStderrBytes || 512 * 1024; // 512KB

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let isSettled = false;
    let activeStream = null;

    const terminateStream = (stream) => {
      if (!stream) return;
      try { stream.signal('KILL'); } catch (_) {}
      try { stream.close(); } catch (_) {}
      try { stream.end(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
    };

    const timeoutTimer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        terminateStream(activeStream);
        resolve({
          success: false,
          code: -1,
          signal: 'SIGTIMEOUT',
          stdout: stdout.trim(),
          stderr: (stderr + `\n[Error: Command timed out after ${timeoutMs}ms]`).trim(),
          timeout: true
        });
      }
    }, timeoutMs);

    client.exec(commandString, (err, stream) => {
      if (err) {
        clearTimeout(timeoutTimer);
        if (isSettled) return;
        isSettled = true;
        return reject(err);
      }

      activeStream = stream;
      if (isSettled) {
        terminateStream(stream);
        return;
      }

      stream.on('data', (data) => {
        if (stdout.length < maxStdoutBytes) {
          stdout += data.toString('utf-8');
        } else if (!stdoutTruncated) {
          stdoutTruncated = true;
          stdout += '\n[Output truncated: exceeded max stdout limit]';
        }
      });

      stream.stderr.on('data', (data) => {
        if (stderr.length < maxStderrBytes) {
          stderr += data.toString('utf-8');
        } else if (!stderrTruncated) {
          stderrTruncated = true;
          stderr += '\n[Error output truncated: exceeded max stderr limit]';
        }
      });

      stream.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (!isSettled) {
          isSettled = true;
          resolve({
            success: code === 0,
            code: code !== null ? code : (signal ? -1 : 0),
            signal: signal || null,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            stdoutTruncated,
            stderrTruncated
          });
        }
      });

      stream.on('error', (streamErr) => {
        clearTimeout(timeoutTimer);
        if (!isSettled) {
          isSettled = true;
          resolve({
            success: false,
            code: -1,
            signal: null,
            stdout: stdout.trim(),
            stderr: (stderr + `\n[Stream Error: ${streamErr.message}]`).trim()
          });
        }
      });
    });
  });
}

/**
 * Open a TCP connection from the remote SSH host.
 */
export async function createForwardedConnection(remoteHost, remotePort) {
  const client = await getClient();
  const host = String(remoteHost || '127.0.0.1');
  const port = Number.parseInt(remotePort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid forwarded port: ${remotePort}`);
  }

  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

export async function getSftp() {
  const client = await getClient();
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

export async function createShell(options = {}) {
  const client = await getClient();
  return new Promise((resolve, reject) => {
    client.shell({
      term: options.term || 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24
    }, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}
