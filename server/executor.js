import path from 'path';

/**
 * Safely quote an argument for POSIX shell execution over SSH.
 * Wraps in single quotes and escapes single quotes.
 */
export function quoteArg(arg) {
  if (arg === null || arg === undefined) return "''";
  const str = String(arg);
  // If safe alphanumeric string with common safe chars, return as-is
  if (/^[a-zA-Z0-9_\-\.\:\/\@]+$/.test(str)) {
    return str;
  }
  // Otherwise wrap in single quotes, escaping existing single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Build safe command string from executable and argv array.
 */
export function buildSafeCommand(executable, argv = []) {
  if (!executable || typeof executable !== 'string') {
    throw new Error('Executable must be a non-empty string');
  }

  // Validate executable name (alphanumeric, underscores, hyphens, slashes, dots)
  if (!/^[a-zA-Z0-9_\-\.\/]+$/.test(executable.trim())) {
    throw new Error(`Invalid executable name: ${executable}`);
  }

  const quotedArgs = argv.map(arg => quoteArg(arg));
  return [executable.trim(), ...quotedArgs].join(' ');
}

// -------------------------------------------------------------
// Validation Utilities for Parameter Whitelisting & Normalization
// -------------------------------------------------------------

export const SYSTEMD_ACTIONS = new Set([
  'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status'
]);

export function validateSystemdAction(action) {
  if (!action || typeof action !== 'string' || !SYSTEMD_ACTIONS.has(action.toLowerCase())) {
    throw new Error(`非法 Systemd 指令: ${action}。仅允许: ${Array.from(SYSTEMD_ACTIONS).join(', ')}`);
  }
  return action.toLowerCase();
}

export function validateServiceName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('服务名称不能为空');
  }
  const clean = name.trim();
  if (!/^[a-zA-Z0-9_\-@\.:]+$/.test(clean)) {
    throw new Error(`非法服务名称格式: ${clean}`);
  }
  return clean.endsWith('.service') ? clean : `${clean}.service`;
}

export const DOCKER_ACTIONS = new Set([
  'start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'rm'
]);

export function validateDockerAction(action) {
  if (!action || typeof action !== 'string' || !DOCKER_ACTIONS.has(action.toLowerCase())) {
    throw new Error(`非法 Docker 操作: ${action}。仅允许: ${Array.from(DOCKER_ACTIONS).join(', ')}`);
  }
  return action.toLowerCase();
}

export function validateDockerIdentifier(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('Docker ID / 名称不能为空');
  }
  const clean = id.trim();
  if (!/^[a-zA-Z0-9_\-\.\:\/]+$/.test(clean)) {
    throw new Error(`非法 Docker 标识符: ${clean}`);
  }
  return clean;
}

export function validatePort(port) {
  const str = String(port).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`非法端口号: ${port}`);
  }
  const parsed = parseInt(str, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`非法端口号: ${port}。必须在 1-65535 之间。`);
  }
  return parsed;
}

export function validateSafePath(inputPath, allowRoot = false) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('路径参数不能为空');
  }
  if (inputPath.includes('\0')) {
    throw new Error('路径包含非法空字符 (Null byte)');
  }

  // Normalize path using forward slashes
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, '/').trim());
  if (!normalized.startsWith('/')) {
    throw new Error('路径必须为绝对路径 (以 / 开头)');
  }

  return normalized;
}

/**
 * Validate that an absolute POSIX path is equal to, or contained by, one of
 * the configured roots. String prefix checks are intentionally avoided.
 */
export function validatePathWithinRoots(inputPath, roots, options = {}) {
  const cleanPath = validateSafePath(inputPath, options.allowRoot === true);
  const cleanRoots = (Array.isArray(roots) ? roots : [])
    .map((root) => validateSafePath(root, true))
    .filter((root, index, all) => all.indexOf(root) === index);

  if (cleanRoots.length === 0) {
    throw new Error('未配置允许访问的根目录');
  }

  const matchingRoot = cleanRoots.find((root) => {
    const relative = path.posix.relative(root, cleanPath);
    return relative === '' || (
      !relative.startsWith('../')
      && relative !== '..'
      && !path.posix.isAbsolute(relative)
    );
  });

  if (!matchingRoot) {
    throw new Error(`路径必须位于允许的根目录内 (${cleanRoots.join(', ')})`);
  }

  return { path: cleanPath, root: matchingRoot };
}

export function validateSignal(sig) {
  const signalStr = String(sig).trim().toUpperCase().replace(/^SIG/, '');
  const allowed = ['1', '2', '9', '15', 'HUP', 'INT', 'KILL', 'TERM'];
  if (!allowed.includes(signalStr)) {
    throw new Error(`非法信号: ${sig}。仅支持常用控制信号 (1, 2, 9, 15)`);
  }
  return signalStr;
}

export function validatePid(pid) {
  if (pid === null || pid === undefined) {
    throw new Error('PID 不能为空');
  }
  const str = String(pid).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`非法进程 PID: ${pid}`);
  }
  const parsed = parseInt(str, 10);
  if (parsed <= 1 || parsed > 4194304) {
    throw new Error(`非法进程 PID: ${pid}`);
  }
  return parsed;
}
