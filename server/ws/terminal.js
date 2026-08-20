import { createShell } from '../sshManager.js';

export function handleTerminalWebSocket(ws) {
  let shellStream = null;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    if (shellStream) {
      try {
        shellStream.end();
        shellStream.destroy();
      } catch (_) {}
      shellStream = null;
    }
  };

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'init') {
        if (shellStream) return;
        try {
          shellStream = await createShell({
            cols: Math.min(Math.max(msg.cols || 80, 20), 300),
            rows: Math.min(Math.max(msg.rows || 24, 10), 120),
            term: msg.term || 'xterm-256color'
          });

          shellStream.on('data', (data) => {
            if (ws.readyState === 1) { // OPEN
              ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }));
            }
          });

          shellStream.on('close', () => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'close', message: '\r\n\x1b[33m[远程 SSH 会话已关闭]\x1b[0m\r\n' }));
              try { ws.close(); } catch (_) {}
            }
            cleanup();
          });

          shellStream.on('error', (err) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', message: `\r\n\x1b[31m[终端错误: ${err.message}]\x1b[0m\r\n` }));
            }
          });

          ws.send(JSON.stringify({ type: 'ready', message: 'SSH 交互终端已就绪\r\n' }));
        } catch (err) {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'error', message: `\r\n\x1b[31m[无法连接 SSH 终端: ${err.message}]\x1b[0m\r\n` }));
          }
        }
      } else if (msg.type === 'data') {
        if (shellStream && shellStream.writable && typeof msg.data === 'string') {
          shellStream.write(msg.data);
        }
      } else if (msg.type === 'resize') {
        if (shellStream && typeof shellStream.setWindow === 'function') {
          const rows = Math.min(Math.max(msg.rows || 24, 10), 120);
          const cols = Math.min(Math.max(msg.cols || 80, 20), 300);
          shellStream.setWindow(rows, cols, 0, 0);
        }
      }
    } catch (e) {
      if (shellStream && shellStream.writable) {
        shellStream.write(raw.toString());
      }
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
