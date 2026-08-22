import { createShell } from '../sshManager.js';

const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

function clampDimension(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function normalizeTerminalType(value) {
  const term = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._+-]{1,64}$/.test(term) ? term : 'xterm-256color';
}

export function handleTerminalWebSocket(ws, request = null, dependencies = {}) {
  const createShellFn = dependencies.createShellFn || createShell;
  let shellStream = null;
  let shellPromise = null;
  let isClosed = false;

  const destroyShell = (stream) => {
    if (stream) {
      try {
        stream.end();
        stream.destroy();
      } catch (_) {}
    }
  };

  const cleanup = () => {
    isClosed = true;
    const stream = shellStream;
    shellStream = null;
    destroyShell(stream);
  };

  const sendMessage = (message) => {
    if (isClosed || ws.readyState !== 1) return false;
    if (ws.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
      try { ws.close(1013, 'Terminal client is too slow'); } catch (_) {}
      cleanup();
      return false;
    }
    try {
      ws.send(JSON.stringify(message), (error) => {
        if (error) cleanup();
      });
      return true;
    } catch (_) {
      cleanup();
      return false;
    }
  };

  const writeShellInput = (data) => {
    if (!shellStream?.writable || typeof data !== 'string') return;
    if (shellStream.write(data) === false) {
      try { ws.pause?.(); } catch (_) {}
      shellStream.once('drain', () => {
        if (!isClosed) {
          try { ws.resume?.(); } catch (_) {}
        }
      });
    }
  };

  ws.on('message', async (raw) => {
    if (isClosed) return;
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'init') {
        if (shellStream || shellPromise) return;
        const pendingShell = createShellFn({
          cols: clampDimension(msg.cols, 80, 20, 300),
          rows: clampDimension(msg.rows, 24, 10, 120),
          term: normalizeTerminalType(msg.term),
          expectedTargetContext: request?.sshTargetContext || null
        });
        shellPromise = pendingShell;
        try {
          const stream = await pendingShell;
          if (isClosed) {
            destroyShell(stream);
            return;
          }
          shellStream = stream;

          shellStream.on('data', (data) => {
            sendMessage({ type: 'data', data: data.toString('utf-8') });
          });

          shellStream.on('close', () => {
            if (!isClosed) {
              sendMessage({ type: 'close', message: '\r\n\x1b[33m[远程 SSH 会话已关闭]\x1b[0m\r\n' });
              try { ws.close(); } catch (_) {}
            }
            cleanup();
          });

          shellStream.on('error', (err) => {
            sendMessage({ type: 'error', message: `\r\n\x1b[31m[终端错误: ${err.message}]\x1b[0m\r\n` });
          });

          sendMessage({ type: 'ready', message: 'SSH 交互终端已就绪\r\n' });
        } catch (err) {
          sendMessage({ type: 'error', message: `\r\n\x1b[31m[无法连接 SSH 终端: ${err.message}]\x1b[0m\r\n` });
        } finally {
          if (shellPromise === pendingShell) shellPromise = null;
        }
      } else if (msg.type === 'data') {
        writeShellInput(msg.data);
      } else if (msg.type === 'resize') {
        if (shellStream && typeof shellStream.setWindow === 'function') {
          const rows = clampDimension(msg.rows, 24, 10, 120);
          const cols = clampDimension(msg.cols, 80, 20, 300);
          shellStream.setWindow(rows, cols, 0, 0);
        }
      }
    } catch (_) {
      writeShellInput(raw.toString());
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
