import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { getConfig } from './config.js';
import {
  assertSshTargetEpoch,
  captureSshTargetContext,
  disconnect,
  getClient,
  getConnectionStatus,
  onSshTargetEpochChanged,
  runWithSshTargetContext
} from './sshManager.js';
import { authMiddleware, authenticateWebSocketRequest, getSession, onSessionInvalidated } from './auth.js';
import { applySecurityHeaders, verifyWebSocketOrigin } from './securityHeaders.js';
import { metricsCollector } from './metricsCollector.js';

import authRoutes from './routes/auth.js';
import systemRoutes from './routes/system.js';
import dockerRoutes from './routes/docker.js';
import filesRoutes from './routes/files.js';
import servicesRoutes from './routes/services.js';
import scriptsRoutes from './routes/scripts.js';
import llmRoutes from './routes/llm.js';
import fanRoutes from './routes/fan.js';
import { handleTerminalWebSocket } from './ws/terminal.js';
import { handleMetricsWebSocket } from './ws/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
server.headersTimeout = 15_000;
server.requestTimeout = 10 * 60_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 1000;

// 1. Trust Proxy Configuration (Explicit, defaults to false)
const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv === 'true' || trustProxyEnv === '1') {
  app.set('trust proxy', 1);
} else if (trustProxyEnv) {
  app.set('trust proxy', trustProxyEnv);
} else {
  app.set('trust proxy', false);
}

// 2. Security Headers & CORS
app.use(applySecurityHeaders);

// 3. Authenticate private APIs before spending work parsing request bodies.
app.use('/api', authMiddleware);

const TARGET_EPOCH_EXEMPT_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/auth-status',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout'
]);

// A session cookie is shared by browser tabs. Bind every target-sensitive API
// request to the opaque server epoch observed by that tab so a stale tab cannot
// mutate whichever SSH server another tab selected later.
app.use('/api', (req, res, next) => {
  const pathname = String(req.originalUrl || '').split('?', 1)[0];
  if (TARGET_EPOCH_EXEMPT_PATHS.has(pathname)) return next();
  const expectedEpoch = req.get('x-ssh-target-epoch') || req.query?.targetEpoch;
  try {
    assertSshTargetEpoch(expectedEpoch);
    return next();
  } catch (error) {
    const missing = error?.code === 'SSH_TARGET_EPOCH_REQUIRED';
    return res.status(missing ? 428 : 409).json({
      success: false,
      code: error.code,
      error: missing
        ? '请求缺少服务器目标版本，请刷新页面后重试'
        : '服务器已在其他页面切换，请刷新当前页面后重试',
      targetEpoch: error.targetEpoch
    });
  }
});

// Bind every API operation to the SSH target that was active when the request
// arrived. Queued work is rejected if a profile switch happens meanwhile.
app.use('/api', (req, _res, next) => {
  const targetContext = captureSshTargetContext();
  req.sshTargetContext = targetContext;
  runWithSshTargetContext(targetContext, next);
});

// 4. API payloads are JSON-only except for the explicitly bounded multipart
// upload route. Keeping urlencoded form bodies disabled also narrows CSRF risk.
app.use('/api', express.json({ limit: '2mb' }));

// 5. Static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// 6. Mount API Sub-Routes
app.use('/api/auth', authRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/docker', dockerRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/scripts', scriptsRoutes);
app.use('/api/llm', llmRoutes);
app.use('/api/fan', fanRoutes);
// Unknown API routes always return machine-readable responses.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// 7. Fallback index.html for SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
// Normalize parser and unexpected errors without exposing stack traces.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = Number.isInteger(err.status) ? err.status : 500;
  let message = 'Internal server error';
  if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed request body';
  } else if (status >= 400 && status < 500 && err.message) {
    message = err.message;
  }
  if (status >= 500) console.error('[HTTP] Unhandled request error:', err);
  res.status(status).json({ success: false, error: message });
});

// 8. WebSocket Setup with Upgrade Auth & Origin Verification
function boundedEnvironmentInteger(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const MAX_TERMINAL_WEBSOCKETS = boundedEnvironmentInteger(process.env.MAX_TERMINAL_WEBSOCKETS, 32, 1, 256);
const MAX_METRICS_WEBSOCKETS = boundedEnvironmentInteger(process.env.MAX_METRICS_WEBSOCKETS, 64, 1, 512);
const wssTerminal = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const wssMetrics = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
const authenticatedWebSockets = new Set();
let websocketHeartbeatTimer = null;

onSshTargetEpochChanged(() => {
  // Interactive shells must never survive a target transition. Metrics sockets
  // remain open long enough to deliver the new epoch to every browser tab.
  for (const ws of wssTerminal.clients) {
    try { ws.close(1012, 'SSH target changed'); } catch (_) {}
    try { ws.terminate(); } catch (_) {}
  }
});

function registerAuthenticatedWebSocket(ws, request) {
  ws.authSessionToken = request.authSessionToken;
  ws.isAlive = true;
  authenticatedWebSockets.add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  const remove = () => authenticatedWebSockets.delete(ws);
  ws.once('close', remove);
  ws.once('error', remove);
}

onSessionInvalidated((token) => {
  for (const ws of authenticatedWebSockets) {
    if (ws.authSessionToken !== token) continue;
    try { ws.close(1008, 'Session expired or signed out'); } catch (_) {}
    try { ws.terminate(); } catch (_) {}
    authenticatedWebSockets.delete(ws);
  }
});

function startWebSocketHeartbeat() {
  if (websocketHeartbeatTimer) return;
  websocketHeartbeatTimer = setInterval(() => {
    for (const ws of authenticatedWebSockets) {
      if (!getSession(ws.authSessionToken, { touch: false }) || ws.isAlive === false) {
        try { ws.close(1008, 'Session expired or connection timed out'); } catch (_) {}
        try { ws.terminate(); } catch (_) {}
        authenticatedWebSockets.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {
        try { ws.terminate(); } catch (_) {}
        authenticatedWebSockets.delete(ws);
      }
    }
  }, 30_000);
  websocketHeartbeatTimer.unref?.();
}

wssTerminal.on('connection', handleTerminalWebSocket);
wssMetrics.on('connection', handleMetricsWebSocket);

server.on('upgrade', (request, socket, head) => {
  // Step A: Origin Verification
  if (!verifyWebSocketOrigin(request)) {
    console.warn(`[Security] Rejected WebSocket connection from unauthorized origin: ${request.headers.origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Step B: Authentication Verification (Verifies active session in session store)
  if (!authenticateWebSocketRequest(request)) {
    console.warn('[Security] Rejected unauthenticated WebSocket upgrade request');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let requestUrl;
  try {
    // The Host header is untrusted and may be syntactically invalid. Only the
    // request target is needed for routing, so parse it against a fixed base.
    requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  } catch (_) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const pathname = requestUrl.pathname;
  try {
    assertSshTargetEpoch(requestUrl.searchParams.get('targetEpoch'));
  } catch (error) {
    const status = error?.code === 'SSH_TARGET_EPOCH_REQUIRED' ? 428 : 409;
    socket.write(`HTTP/1.1 ${status} ${status === 428 ? 'Precondition Required' : 'Conflict'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  request.sshTargetContext = captureSshTargetContext();

  if (pathname === '/ws/terminal') {
    if (wssTerminal.clients.size >= MAX_TERMINAL_WEBSOCKETS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n');
      socket.destroy();
      return;
    }
    wssTerminal.handleUpgrade(request, socket, head, (ws) => {
      registerAuthenticatedWebSocket(ws, request);
      wssTerminal.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/metrics') {
    if (wssMetrics.clients.size >= MAX_METRICS_WEBSOCKETS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\n\r\n');
      socket.destroy();
      return;
    }
    wssMetrics.handleUpgrade(request, socket, head, (ws) => {
      registerAuthenticatedWebSocket(ws, request);
      wssMetrics.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// 9. Network Binding Defaults (127.0.0.1 default for local safety)
const HOST = process.env.HOST || getConfig().serverHost || '127.0.0.1';
let PORT = getConfig().serverPort || 3888;
const configuredPortRetryLimit = Number.parseInt(process.env.PORT_FALLBACK_LIMIT || '10', 10);
const PORT_FALLBACK_LIMIT = Number.isInteger(configuredPortRetryLimit)
  ? Math.min(100, Math.max(0, configuredPortRetryLimit))
  : 10;
const SHUTDOWN_GRACE_MS = boundedEnvironmentInteger(process.env.SHUTDOWN_GRACE_MS, 10_000, 1_000, 60_000);
let runtimeInitialized = false;
let shutdownPromise = null;

function initializeRuntime(portToUse) {
  if (runtimeInitialized) return;
  runtimeInitialized = true;

  console.log(`\n======================================================`);
  console.log(`🚀 Linux / LLM Server Management Dashboard`);
  console.log(`🌐 Local URL: http://${HOST}:${portToUse}`);
  console.log(`🔒 Bound Address: ${HOST} (Safe local default)`);
  console.log(`🔑 Auth: Session Authentication Enabled`);
  console.log(`======================================================\n`);

  metricsCollector.start();
  startWebSocketHeartbeat();

  const cfg = getConfig();
  const autoConnectEnabled = process.env.AUTO_CONNECT !== 'false';
  if (autoConnectEnabled && (cfg.password || cfg.privateKey) && !getConnectionStatus().manuallyDisconnected) {
    console.log(`[SSH] Attempting initial connection to ${cfg.username}@${cfg.host}:${cfg.port}...`);
    getClient()
      .then(() => console.log(`[SSH] ✅ Connection established with ${cfg.host}`))
      .catch((err) => console.log(`[SSH] ⚠️ Initial connection not ready: ${err.message}`));
  }
}

function listenOnce(portToUse) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', handleListening);
      server.off('error', handleError);
    };
    const handleListening = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
    try {
      server.listen(portToUse, HOST);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function startServer(portToUse = PORT) {
  let candidatePort = portToUse;
  for (let retry = 0; retry <= PORT_FALLBACK_LIMIT; retry += 1) {
    PORT = candidatePort;
    try {
      await listenOnce(candidatePort);
      const address = server.address();
      const listeningPort = typeof address === 'object' && address ? address.port : candidatePort;
      PORT = listeningPort;
      initializeRuntime(listeningPort);
      return listeningPort;
    } catch (error) {
      const canRetry = error?.code === 'EADDRINUSE'
        && retry < PORT_FALLBACK_LIMIT
        && candidatePort < 65535;
      if (!canRetry) throw error;
      const nextPort = candidatePort + 1;
      console.warn(`[HTTP] Port ${candidatePort} is in use, trying port ${nextPort}...`);
      candidatePort = nextPort;
    }
  }
  throw new Error('Server failed to bind to an available port');
}

function closeHttpServer() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const forceCloseTimer = setTimeout(() => {
      console.warn(`[HTTP] Grace period of ${SHUTDOWN_GRACE_MS}ms elapsed; closing remaining connections.`);
      server.closeAllConnections?.();
    }, SHUTDOWN_GRACE_MS);
    forceCloseTimer.unref?.();
    server.close(() => {
      clearTimeout(forceCloseTimer);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

function shutdownServer() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (websocketHeartbeatTimer) {
      clearInterval(websocketHeartbeatTimer);
      websocketHeartbeatTimer = null;
    }
    metricsCollector.stop();
    for (const ws of authenticatedWebSockets) {
      try { ws.close(1001, 'Server shutting down'); } catch (_) {}
      try { ws.terminate(); } catch (_) {}
    }
    authenticatedWebSockets.clear();
    for (const ws of [...wssTerminal.clients, ...wssMetrics.clients]) {
      try { ws.terminate(); } catch (_) {}
    }
    disconnect();
    await closeHttpServer();
  })();
  return shutdownPromise;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const handleShutdownSignal = (signal) => {
    console.log(`[HTTP] Received ${signal}; shutting down...`);
    shutdownServer()
      .then(() => { process.exitCode = 0; })
      .catch((error) => {
        console.error('[HTTP] Graceful shutdown failed:', error);
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));
  startServer(PORT).catch((error) => {
    console.error('[HTTP] Server failed to start:', error);
    process.exitCode = 1;
  });
}

export { app, server, startServer, shutdownServer };
