import { Client } from 'ssh2';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, setRuntimeSshOverride } from './config.js';
import { buildSafeCommand } from './executor.js';
import { writeJsonAtomic } from './atomicFile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_KNOWN_HOSTS_FILE = path.join(__dirname, '..', 'data', 'known_hosts.json');

let activeClient = null;
let connectingClient = null;
let connectionAttemptId = 0;
let isConnecting = false;
let connectPromise = null;
let connectionStatus = {
  connected: false,
  lastConnected: null,
  error: null,
  host: null,
  manuallyDisconnected: false
};

export function getKnownHostsFilePath() {
  return process.env.SSH_KNOWN_HOSTS_FILE || DEFAULT_KNOWN_HOSTS_FILE;
}

function loadKnownHosts() {
  const knownHostsFile = getKnownHostsFilePath();
  if (!fs.existsSync(knownHostsFile)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(knownHostsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('known-hosts database must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    console.error('[SSH TOFU] Failed to read known hosts:', error.message);
    return null;
  }
}

function saveKnownHost(hostKey, fingerprint, keyType) {
  try {
    const knownHosts = loadKnownHosts();
    if (!knownHosts) return false;
    knownHosts[hostKey] = {
      fingerprint,
      keyType,
      firstSeen: knownHosts[hostKey]?.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
    writeJsonAtomic(getKnownHostsFilePath(), knownHosts, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (err) {
    console.error('[SSH TOFU] Failed to save known host:', err.message);
    return false;
  }
}

function normalizeKeyFingerprint(keyHash) {
  if (!keyHash) return '';
  if (typeof keyHash === 'string') return keyHash.trim();
  if (Buffer.isBuffer(keyHash)) return keyHash.toString('hex');
  return String(keyHash);
}

export function verifyHostKey(host, port, keyHash, keyType = 'ssh-key') {
  const hostKey = `${host}:${port}`;
  const fingerprint = normalizeKeyFingerprint(keyHash);
  if (!fingerprint) return false;
  const knownHosts = loadKnownHosts();

  if (!knownHosts) return false;
  if (!knownHosts[hostKey] || !knownHosts[hostKey].fingerprint) {
    return saveKnownHost(hostKey, fingerprint, keyType);
  }

  const stored = knownHosts[hostKey];
  if (stored.fingerprint === fingerprint) {
    return true;
  }

  const strictChecking = process.env.SSH_STRICT_HOST_CHECK !== 'false';
  if (strictChecking) {
    console.error(`[SSH TOFU] Host key mismatch for ${hostKey}; refusing the connection.`);
    return false;
  }

  console.warn(`[SSH TOFU] Host key changed for ${hostKey}; replacing it because SSH_STRICT_HOST_CHECK=false.`);
  return saveKnownHost(hostKey, fingerprint, keyType);
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
  connectionAttemptId += 1;
  if (connectingClient) {
    try { connectingClient.end(); } catch (_) {}
    connectingClient = null;
  }
  isConnecting = false;
  connectPromise = null;
  if (activeClient) {
    const client = activeClient;
    activeClient = null;
    try {
      client.end();
    } catch (_) {}
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
    let testClient = null;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { testClient?.end(); } catch (_) {}
      resolve(result);
    };

    try {
      const { sshConfig } = buildSshConfig(customConfig);
      testClient = new Client();

      timer = setTimeout(() => finish({ success: false, error: '连接超时 (10 秒)' }), 10000);

      testClient.on('ready', () => {
        testClient.exec('uname -a', (err, stream) => {
          if (err) {
            return finish({ success: true, message: 'SSH 登录成功' });
          }
          let out = '';
          stream.on('data', (data) => {
            if (out.length < 64 * 1024) out += data.toString('utf8');
          });
          stream.on('error', (error) => finish({ success: false, error: error.message }));
          stream.on('close', () => finish({ success: true, message: '连接成功', system: out.trim() }));
        });
      });

      testClient.on('error', (err) => finish({ success: false, error: err.message }));
      testClient.on('close', () => {
        if (!settled) finish({ success: false, error: 'SSH 连接在验证完成前关闭' });
      });

      testClient.connect(sshConfig);
    } catch (err) {
      finish({ success: false, error: err.message });
    }
  });
}

export async function getClient(forceReconnect = false, customConfig = null) {
  if (activeClient && !forceReconnect && connectionStatus.connected) {
    return activeClient;
  }

  if (isConnecting && connectPromise) {
    if (!forceReconnect) return connectPromise;
    connectionAttemptId += 1;
    try { connectingClient?.end(); } catch (_) {}
    connectingClient = null;
    isConnecting = false;
    connectPromise = null;
  }

  if (customConfig) setRuntimeSshOverride(customConfig);

  let sshConfig;
  let appConfig;
  try {
    ({ sshConfig, appConfig } = buildSshConfig(customConfig));
  } catch (error) {
    connectionStatus.connected = false;
    connectionStatus.error = error.message;
    throw error;
  }

  if (activeClient) {
    const previousClient = activeClient;
    activeClient = null;
    try { previousClient.end(); } catch (_) {}
  }

  const attemptId = ++connectionAttemptId;
  const client = new Client();
  connectingClient = client;
  isConnecting = true;
  connectionStatus.manuallyDisconnected = false;
  let ready = false;
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    const clearPendingAttempt = () => {
      if (attemptId !== connectionAttemptId) return;
      if (connectingClient === client) connectingClient = null;
      isConnecting = false;
      connectPromise = null;
    };

    const rejectPendingAttempt = (error) => {
      if (settled) return;
      settled = true;
      if (attemptId === connectionAttemptId) {
        clearPendingAttempt();
        connectionStatus = {
          connected: false,
          lastConnected: connectionStatus.lastConnected,
          error: error.message,
          host: `${appConfig.username}@${appConfig.host}:${appConfig.port}`,
          manuallyDisconnected: connectionStatus.manuallyDisconnected
        };
      }
      reject(error);
    };

    client.on('ready', () => {
      if (attemptId !== connectionAttemptId || connectionStatus.manuallyDisconnected) {
        try { client.end(); } catch (_) {}
        rejectPendingAttempt(new Error('SSH connection attempt was superseded'));
        return;
      }
      ready = true;
      settled = true;
      activeClient = client;
      clearPendingAttempt();
      connectionStatus = {
        connected: true,
        lastConnected: new Date().toISOString(),
        error: null,
        host: `${appConfig.username}@${appConfig.host}:${appConfig.port}`,
        manuallyDisconnected: false
      };
      resolve(client);
    });

    client.on('error', (err) => {
      if (!ready) {
        rejectPendingAttempt(err);
      } else if (activeClient === client) {
        connectionStatus.connected = false;
        connectionStatus.error = err.message;
      }
    });

    client.on('close', () => {
      if (!ready) rejectPendingAttempt(new Error('SSH connection closed before it became ready'));
      if (activeClient === client) {
        activeClient = null;
        connectionStatus.connected = false;
      }
    });

    client.on('end', () => {
      if (activeClient === client) {
        activeClient = null;
        connectionStatus.connected = false;
      }
    });
  });

  connectPromise = promise;
  try {
    client.connect(sshConfig);
  } catch (error) {
    client.emit('error', error);
  }
  return promise;
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
  const abortSignal = options.signal;
  if (abortSignal?.aborted) {
    return { success: false, code: -1, signal: 'SIGABRT', stdout: '', stderr: 'Command aborted', aborted: true };
  }

  const client = await getClient();
  const timeoutMs = options.timeoutMs || options.timeout || 15000;
  const maxStdoutBytes = options.maxStdoutBytes || 2 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes || 512 * 1024;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let isSettled = false;
    let activeStream = null;
    let timeoutTimer = null;

    const terminateStream = (stream) => {
      if (!stream) return;
      try { stream.signal('KILL'); } catch (_) {}
      try { stream.close(); } catch (_) {}
      try { stream.end(); } catch (_) {}
      try { stream.destroy(); } catch (_) {}
    };

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      abortSignal?.removeEventListener('abort', handleAbort);
    };

    const finish = (result) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(error);
    };

    const appendBounded = (data, isError = false) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const maxBytes = isError ? maxStderrBytes : maxStdoutBytes;
      const usedBytes = isError ? stderrBytes : stdoutBytes;
      const remaining = Math.max(0, maxBytes - usedBytes);
      const text = buffer.subarray(0, remaining).toString('utf8');
      if (isError) {
        stderr += text;
        stderrBytes += Math.min(buffer.length, remaining);
        if (buffer.length > remaining && !stderrTruncated) {
          stderrTruncated = true;
          stderr += '\n[Error output truncated: exceeded max stderr limit]';
        }
      } else {
        stdout += text;
        stdoutBytes += Math.min(buffer.length, remaining);
        if (buffer.length > remaining && !stdoutTruncated) {
          stdoutTruncated = true;
          stdout += '\n[Output truncated: exceeded max stdout limit]';
        }
      }
    };

    function handleAbort() {
      terminateStream(activeStream);
      finish({
        success: false,
        code: -1,
        signal: 'SIGABRT',
        stdout: stdout.trim(),
        stderr: (stderr + '\n[Error: Command aborted]').trim(),
        aborted: true,
        stdoutTruncated,
        stderrTruncated
      });
    }

    abortSignal?.addEventListener('abort', handleAbort, { once: true });
    if (abortSignal?.aborted) {
      handleAbort();
      return;
    }

    timeoutTimer = setTimeout(() => {
      terminateStream(activeStream);
      finish({
        success: false,
        code: -1,
        signal: 'SIGTIMEOUT',
        stdout: stdout.trim(),
        stderr: (stderr + `\n[Error: Command timed out after ${timeoutMs}ms]`).trim(),
        timeout: true,
        stdoutTruncated,
        stderrTruncated
      });
    }, timeoutMs);

    client.exec(commandString, (err, stream) => {
      if (err) return fail(err);
      activeStream = stream;
      if (isSettled) {
        terminateStream(stream);
        return;
      }

      stream.on('data', (data) => appendBounded(data));
      stream.stderr.on('data', (data) => appendBounded(data, true));
      stream.on('close', (code, signal) => finish({
        success: code === 0,
        code: code !== null ? code : (signal ? -1 : 0),
        signal: signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        stdoutTruncated,
        stderrTruncated
      }));
      stream.on('error', (streamErr) => finish({
        success: false,
        code: -1,
        signal: null,
        stdout: stdout.trim(),
        stderr: (stderr + `\n[Stream Error: ${streamErr.message}]`).trim(),
        stdoutTruncated,
        stderrTruncated
      }));
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
