import { Client } from 'ssh2';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, setRuntimeSshOverride } from './config.js';
import { buildSafeCommand } from './executor.js';
import { writeJsonAtomic } from './atomicFile.js';
import { ConcurrencyLimiter } from './concurrencyLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_KNOWN_HOSTS_FILE = path.join(__dirname, '..', 'data', 'known_hosts.json');

function boundedEnvironmentInteger(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const commandLimiter = new ConcurrencyLimiter(
  boundedEnvironmentInteger(process.env.MAX_CONCURRENT_SSH_COMMANDS, 12, 1, 64),
  boundedEnvironmentInteger(process.env.MAX_QUEUED_SSH_COMMANDS, 64, 0, 1000),
  boundedEnvironmentInteger(process.env.SSH_COMMAND_QUEUE_TIMEOUT_MS, 10_000, 100, 60_000)
);

export class SshConnectionCoordinator {
  constructor({ maxQueue = 8, queueTimeoutMs = 30_000 } = {}) {
    this.limiter = new ConcurrencyLimiter(1, maxQueue, queueTimeoutMs);
  }

  run(operation, options = {}) {
    return this.limiter.run(operation, options);
  }
}

const connectionCoordinator = new SshConnectionCoordinator({
  maxQueue: boundedEnvironmentInteger(process.env.MAX_QUEUED_SSH_CONNECTIONS, 8, 0, 64),
  queueTimeoutMs: boundedEnvironmentInteger(process.env.SSH_CONNECTION_QUEUE_TIMEOUT_MS, 30_000, 1_000, 120_000)
});
const sshTargetContextStorage = new AsyncLocalStorage();

let activeClient = null;
let connectingClient = null;
let connectionAttemptId = 0;
let connectionTargetGeneration = 0;
const connectionTargetNonce = crypto.randomBytes(16).toString('base64url');
const connectionTargetEpochListeners = new Set();
let isConnecting = false;
let connectPromise = null;
let connectionStatus = {
  connected: false,
  lastConnected: null,
  error: null,
  host: null,
  manuallyDisconnected: false
};

function targetIdentityFromConfig(config = getConfig()) {
  const username = String(config.username || 'root');
  const host = String(config.host || '127.0.0.1');
  const port = Number(config.port || 22);
  return `${username}@${host}:${port}`;
}

// Target identity is deliberately independent from transport liveness. A
// reconnect to the same host must not invalidate the request that initiated
// it, while a real profile/host switch still invalidates queued old-target work.
let connectionTargetId = targetIdentityFromConfig();

function formatConnectionTargetEpoch(generation = connectionTargetGeneration) {
  return `${connectionTargetNonce}.${generation}`;
}

function notifyConnectionTargetEpochChanged(reason) {
  const event = Object.freeze({
    targetEpoch: formatConnectionTargetEpoch(),
    generation: connectionTargetGeneration,
    targetId: connectionTargetId,
    reason
  });
  // Notify after the current state transition finishes. This prevents a
  // listener from observing the new epoch alongside the previous status.
  queueMicrotask(() => {
    for (const listener of connectionTargetEpochListeners) {
      try { listener(event); } catch (_) {}
    }
  });
}

function advanceConnectionTargetEpoch(reason) {
  connectionTargetGeneration += 1;
  notifyConnectionTargetEpochChanged(reason);
}

function synchronizeConfiguredTargetIdentity() {
  if (connectionStatus.connected || isConnecting) return;
  const configuredTargetId = targetIdentityFromConfig();
  if (configuredTargetId === connectionTargetId) return;
  connectionTargetId = configuredTargetId;
  advanceConnectionTargetEpoch('configured-target-changed');
}

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
  synchronizeConfiguredTargetIdentity();
  return { ...connectionStatus, targetEpoch: formatConnectionTargetEpoch() };
}

export function runSshConnectionTransition(operation, options = {}) {
  return connectionCoordinator.run(operation, options);
}

export function getSshTargetEpoch() {
  synchronizeConfiguredTargetIdentity();
  return formatConnectionTargetEpoch();
}

export function assertSshTargetEpoch(expectedEpoch) {
  const currentEpoch = getSshTargetEpoch();
  if (typeof expectedEpoch !== 'string' || !expectedEpoch) {
    const error = new Error('SSH target epoch is required');
    error.code = 'SSH_TARGET_EPOCH_REQUIRED';
    error.targetEpoch = currentEpoch;
    throw error;
  }
  if (expectedEpoch !== currentEpoch) {
    const error = new Error('The browser view belongs to an outdated SSH target');
    error.code = 'SSH_TARGET_STALE';
    error.targetEpoch = currentEpoch;
    throw error;
  }
  return true;
}

export function onSshTargetEpochChanged(listener) {
  if (typeof listener !== 'function') throw new TypeError('SSH target epoch listener must be a function');
  connectionTargetEpochListeners.add(listener);
  return () => connectionTargetEpochListeners.delete(listener);
}

export function captureSshTargetContext() {
  synchronizeConfiguredTargetIdentity();
  return Object.freeze({
    generation: connectionTargetGeneration,
    targetId: connectionTargetId,
    targetEpoch: formatConnectionTargetEpoch()
  });
}

export function runWithSshTargetContext(context, operation) {
  if (typeof operation !== 'function') throw new TypeError('SSH target context operation must be a function');
  return sshTargetContextStorage.run(context || captureSshTargetContext(), operation);
}

export function assertSshTargetContext(context = sshTargetContextStorage.getStore()) {
  if (!context) return true;
  const targetChanged = context.generation !== connectionTargetGeneration
    || (context.targetId && connectionTargetId && context.targetId !== connectionTargetId);
  if (targetChanged) {
    const error = new Error('Target server changed while the remote operation was pending');
    error.code = 'SSH_TARGET_CHANGED';
    throw error;
  }
  return true;
}

export function disconnect() {
  advanceConnectionTargetEpoch('disconnect');
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

  // Forced transitions wait for the candidate already in flight instead of
  // superseding it. Route-level transitions also use a bounded coordinator,
  // while this loop protects direct callers of getClient().
  while (isConnecting && connectPromise) {
    if (!forceReconnect) return connectPromise;
    try {
      await connectPromise;
    } catch (_) {
      // A failed candidate leaves the previous active connection untouched.
    }
  }

  if (activeClient && !forceReconnect && connectionStatus.connected) {
    return activeClient;
  }

  let sshConfig;
  let appConfig;
  try {
    ({ sshConfig, appConfig } = buildSshConfig(customConfig));
  } catch (error) {
    throw error;
  }

  const attemptId = ++connectionAttemptId;
  const client = new Client();
  const previousClient = activeClient;
  const statusBeforeAttempt = { ...connectionStatus };
  connectingClient = client;
  isConnecting = true;
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
        if (!activeClient) {
          connectionStatus = {
            ...statusBeforeAttempt,
            connected: false,
            error: error.message
          };
        }
      }
      reject(error);
    };

    client.on('ready', () => {
      if (attemptId !== connectionAttemptId) {
        try { client.end(); } catch (_) {}
        rejectPendingAttempt(new Error('SSH connection attempt was superseded'));
        return;
      }
      ready = true;
      settled = true;
      activeClient = client;
      clearPendingAttempt();
      const nextTargetId = `${appConfig.username}@${appConfig.host}:${appConfig.port}`;
      if (nextTargetId !== connectionTargetId) {
        connectionTargetId = nextTargetId;
        advanceConnectionTargetEpoch('target-connected');
      }
      connectionStatus = {
        connected: true,
        lastConnected: new Date().toISOString(),
        error: null,
        host: nextTargetId,
        manuallyDisconnected: false
      };

      // A custom target becomes the runtime target only after the SSH
      // handshake succeeds. Failed candidates therefore cannot poison config.
      if (customConfig) {
        setRuntimeSshOverride({
          host: appConfig.host,
          port: appConfig.port,
          username: appConfig.username,
          authType: appConfig.authType,
          password: appConfig.password || '',
          privateKey: appConfig.privateKey || '',
          passphrase: appConfig.passphrase || '',
          activeProfileId: Object.prototype.hasOwnProperty.call(customConfig, 'activeProfileId')
            ? customConfig.activeProfileId
            : null
        });
      }

      if (previousClient && previousClient !== client) {
        try { previousClient.end(); } catch (_) {}
      }
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
  const expectedTargetContext = options.expectedTargetContext || sshTargetContextStorage.getStore() || null;
  try {
    return await commandLimiter.run(
      () => executeInternalCommand(commandString, { ...options, expectedTargetContext }),
      { signal: options.signal }
    );
  } catch (error) {
    if (error?.code === 'ABORT_ERR') {
      return {
        success: false,
        code: -1,
        signal: 'SIGABRT',
        stdout: '',
        stderr: 'Command aborted while waiting to run',
        aborted: true
      };
    }
    throw error;
  }
}

async function executeInternalCommand(commandString, options = {}) {
  const abortSignal = options.signal;
  if (abortSignal?.aborted) {
    return { success: false, code: -1, signal: 'SIGABRT', stdout: '', stderr: 'Command aborted', aborted: true };
  }

  assertSshTargetContext(options.expectedTargetContext);
  const client = await getClient();
  assertSshTargetContext(options.expectedTargetContext);
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
        // A transport close without a remote exit status is indeterminate, not
        // a successful exit. Callers that launch background work must preserve
        // their ownership state and recover it instead of cleaning blindly.
        code: code !== null && code !== undefined ? code : -1,
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
  const expectedTargetContext = sshTargetContextStorage.getStore() || null;
  assertSshTargetContext(expectedTargetContext);
  const client = await getClient();
  assertSshTargetContext(expectedTargetContext);
  const host = String(remoteHost || '127.0.0.1');
  const port = Number.parseInt(remotePort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid forwarded port: ${remotePort}`);
  }

  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) return reject(err);
      try {
        assertSshTargetContext(expectedTargetContext);
      } catch (error) {
        try { stream.end(); } catch (_) {}
        try { stream.destroy(); } catch (_) {}
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}

export async function getSftp() {
  const expectedTargetContext = sshTargetContextStorage.getStore() || null;
  assertSshTargetContext(expectedTargetContext);
  const client = await getClient();
  assertSshTargetContext(expectedTargetContext);
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      try {
        assertSshTargetContext(expectedTargetContext);
      } catch (error) {
        try { sftp.end(); } catch (_) {}
        reject(error);
        return;
      }
      resolve(sftp);
    });
  });
}

export async function createShell(options = {}) {
  const expectedTargetContext = options.expectedTargetContext || sshTargetContextStorage.getStore() || null;
  assertSshTargetContext(expectedTargetContext);
  const client = await getClient();
  assertSshTargetContext(expectedTargetContext);
  return new Promise((resolve, reject) => {
    client.shell({
      term: options.term || 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24
    }, (err, stream) => {
      if (err) return reject(err);
      try {
        assertSshTargetContext(expectedTargetContext);
      } catch (error) {
        try { stream.end(); } catch (_) {}
        try { stream.destroy(); } catch (_) {}
        reject(error);
        return;
      }
      resolve(stream);
    });
  });
}
