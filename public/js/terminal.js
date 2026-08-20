// Web Terminal with xterm.js

const terminalText = (zh, en) => window.localize ? window.localize(zh, en) : en;

let term = null;
let fitAddon = null;
let termWs = null;

const XTERM_CSS_URL = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css';
const XTERM_JS_URL = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js';
const XTERM_FIT_URL = 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js';
let terminalAssetsPromise = null;

function loadTerminalStylesheet() {
  if (document.getElementById('xterm-stylesheet')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.id = 'xterm-stylesheet';
    link.rel = 'stylesheet';
    link.href = XTERM_CSS_URL;
    link.onload = resolve;
    link.onerror = () => {
      link.remove();
      reject(new Error(terminalText('终端样式加载失败', 'Failed to load terminal styles')));
    };
    document.head.appendChild(link);
  });
}

function loadTerminalScript(id, src) {
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error(terminalText('终端组件加载失败', 'Failed to load terminal component')));
    };
    document.head.appendChild(script);
  });
}

async function ensureTerminalAssets() {
  if (window.Terminal && window.FitAddon?.FitAddon) return;
  if (!terminalAssetsPromise) {
    terminalAssetsPromise = (async () => {
      await Promise.all([
        loadTerminalStylesheet(),
        window.Terminal ? Promise.resolve() : loadTerminalScript('xterm-script', XTERM_JS_URL)
      ]);
      if (!window.FitAddon?.FitAddon) {
        await loadTerminalScript('xterm-fit-script', XTERM_FIT_URL);
      }
      if (!window.Terminal || !window.FitAddon?.FitAddon) {
        throw new Error(terminalText('终端组件初始化失败', 'Failed to initialize terminal component'));
      }
    })();
  }

  try {
    await terminalAssetsPromise;
  } catch (error) {
    terminalAssetsPromise = null;
    throw error;
  }
}
window.initTerminal = async function () {
  const container = document.getElementById('terminal-container');
  if (!container) return;

  try {
    await ensureTerminalAssets();
  } catch (error) {
    container.textContent = terminalText('终端组件加载失败。请检查网络连接或在本地托管 xterm.js 资源。', 'The terminal component failed to load. Check the network connection or host the xterm.js assets locally.');
    container.setAttribute('role', 'alert');
    window.toast(error.message, 'error');
    return;
  }

  // Initialize xterm if not already done
  if (!term && typeof Terminal !== 'undefined') {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#3b82f644',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4'
      }
    });

    if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }

    term.open(container);
    if (fitAddon) {
      setTimeout(() => fitAddon.fit(), 100);
    }

    // Input event
    term.onData((data) => {
      if (termWs && termWs.readyState === WebSocket.OPEN) {
        termWs.send(JSON.stringify({ type: 'data', data }));
      }
    });

    // Resize event
    term.onResize((size) => {
      if (termWs && termWs.readyState === WebSocket.OPEN) {
        termWs.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    window.addEventListener('resize', () => {
      if (fitAddon && term) {
        try { fitAddon.fit(); } catch (_) {}
      }
    });
  }

  // Connect or reconnect WebSocket
  connectTerminalWs();

  // Bind Buttons
  document.getElementById('btn-term-clear')?.addEventListener('click', () => {
    if (term) term.clear();
  });

  document.getElementById('btn-term-reconnect')?.addEventListener('click', () => {
    connectTerminalWs(true);
  });
};

function connectTerminalWs(force = false) {
  if (termWs && !force && termWs.readyState === WebSocket.OPEN) return;

  if (termWs) {
    try { termWs.close(); } catch (_) {}
    termWs = null;
  }

  if (term) {
    const targetHost = window.serverConnectionConfig?.host || terminalText('目标服务器', 'target server');
    term.write(terminalText(`\r\n\x1b[36m[正在建立与 ${targetHost} 的 SSH 终端会话...]\x1b[0m\r\n`, `\r\n\x1b[36m[Opening an SSH terminal session to ${targetHost}...]\x1b[0m\r\n`));
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;

  try {
    termWs = new WebSocket(wsUrl);

    termWs.onopen = () => {
      if (term) {
        if (fitAddon) fitAddon.fit();
        const cols = term.cols || 80;
        const rows = term.rows || 24;
        termWs.send(JSON.stringify({ type: 'init', cols, rows }));
      }
    };

    termWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data' && term) {
          term.write(msg.data);
        } else if (msg.type === 'error' && term) {
          term.write(msg.message);
        } else if (msg.type === 'close' && term) {
          term.write(msg.message || terminalText('\r\n[会话已断开]\r\n', '\r\n[Session disconnected]\r\n'));
        }
      } catch (e) {
        if (term) term.write(event.data);
      }
    };

    termWs.onclose = () => {
      if (term) {
        term.write(terminalText('\r\n\x1b[33m[终端连接已关闭，可点击上方「重新连接」]\x1b[0m\r\n', '\r\n\x1b[33m[Terminal connection closed; use Reconnect above]\x1b[0m\r\n'));
      }
    };

    termWs.onerror = (err) => {
      if (term) {
        term.write(terminalText('\r\n\x1b[31m[WebSocket 终端连接异常]\x1b[0m\r\n', '\r\n\x1b[31m[WebSocket terminal connection error]\x1b[0m\r\n'));
      }
    };
  } catch (err) {
    if (term) {
      term.write(terminalText(`\r\n\x1b[31m[无法连接终端: ${err.message}]\x1b[0m\r\n`, `\r\n\x1b[31m[Unable to connect terminal: ${err.message}]\x1b[0m\r\n`));
    }
  }
}

window.resizeTerminal = function () {
  if (fitAddon && term) {
    setTimeout(() => {
      try { fitAddon.fit(); } catch (_) {}
    }, 150);
  }
};
