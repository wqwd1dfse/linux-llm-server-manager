import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { getConfig } from './config.js';
import { getClient, getConnectionStatus } from './sshManager.js';
import { authMiddleware, authenticateWebSocketRequest } from './auth.js';
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

// 3. Request Parsing with reasonable body size (2MB)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 4. Static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// 5. Unified API Authentication Middleware (Mount before all API routes)
app.use('/api', authMiddleware);

// 6. Mount API Sub-Routes
app.use('/api/auth', authRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/docker', dockerRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/scripts', scriptsRoutes);
app.use('/api/llm', llmRoutes);
app.use('/api/fan', fanRoutes);

// 7. Fallback index.html for SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 8. WebSocket Setup with Upgrade Auth & Origin Verification
const wssTerminal = new WebSocketServer({ noServer: true });
const wssMetrics = new WebSocketServer({ noServer: true });

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

  const pathname = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`).pathname;

  if (pathname === '/ws/terminal') {
    wssTerminal.handleUpgrade(request, socket, head, (ws) => {
      wssTerminal.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/metrics') {
    wssMetrics.handleUpgrade(request, socket, head, (ws) => {
      wssMetrics.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// 9. Network Binding Defaults (127.0.0.1 default for local safety)
const HOST = process.env.HOST || getConfig().serverHost || '127.0.0.1';
let PORT = parseInt(process.env.PORT, 10) || getConfig().serverPort || 3888;

function startServer(portToUse) {
  server.listen(portToUse, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Linux / LLM Server Management Dashboard`);
    console.log(`🌐 Local URL: http://${HOST}:${portToUse}`);
    console.log(`🔒 Bound Address: ${HOST} (Safe local default)`);
    console.log(`🔑 Auth: Session Authentication Enabled`);
    console.log(`======================================================\n`);

    metricsCollector.start();

    const cfg = getConfig();
    const autoConnectEnabled = process.env.AUTO_CONNECT !== 'false';
    if (autoConnectEnabled && (cfg.password || cfg.privateKey) && !getConnectionStatus().manuallyDisconnected) {
      console.log(`[SSH] Attempting initial connection to ${cfg.username}@${cfg.host}:${cfg.port}...`);
      getClient()
        .then(() => console.log(`[SSH] ✅ Connection established with ${cfg.host}`))
        .catch((err) => console.log(`[SSH] ⚠️ Initial connection not ready: ${err.message}`));
    }
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[HTTP] Port ${PORT} is in use, trying port ${PORT + 1}...`);
    PORT += 1;
    startServer(PORT);
  } else {
    console.error('[HTTP] Server error:', err);
  }
});

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  startServer(PORT);
}

export { app, server, startServer };
