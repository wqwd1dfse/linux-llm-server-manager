import { getSftp, executeCommand } from './sshManager.js';
import { assertNotProtectedTopLevelSystemPath, validateSafePath } from './executor.js';
import { ConcurrencyLimiter } from './concurrencyLimiter.js';
import path from 'path';

function boundedEnvironmentInteger(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function createSftpChannelLimiter(environment = process.env) {
  return new ConcurrencyLimiter(
    boundedEnvironmentInteger(environment.MAX_CONCURRENT_SFTP_CHANNELS, 8, 1, 64),
    boundedEnvironmentInteger(environment.MAX_QUEUED_SFTP_OPERATIONS, 32, 0, 1000),
    boundedEnvironmentInteger(environment.SFTP_QUEUE_TIMEOUT_MS, 10_000, 100, 60_000)
  );
}

const sftpChannelLimiter = createSftpChannelLimiter();

function formatByteLimit(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.ceil(bytes / 1024)}KB`;
}

function formatPermissions(mode) {
  const isDir = (mode & 0o040000) === 0o040000;
  const isSymlink = (mode & 0o120000) === 0o120000;

  let type = '-';
  if (isDir) type = 'd';
  else if (isSymlink) type = 'l';

  const perms = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-'
  ].join('');

  return type + perms;
}

/**
 * Execute an SFTP operation with guaranteed channel teardown.
 */
export async function runWithSftpChannelLimit(operation, options = {}, limiter = sftpChannelLimiter) {
  return limiter.run(operation, { signal: options.signal || null });
}

export async function withSftp(operation, options = {}) {
  return runWithSftpChannelLimit(async () => {
    const sftp = await getSftp();
    try {
      return await operation(sftp);
    } finally {
      try {
        sftp.end();
      } catch (_) {}
    }
  }, options);
}

export async function listFiles(targetPath = '/') {
  const normalized = validateSafePath(targetPath);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.readdir(normalized, (err, list) => {
        if (err) return reject(err);

        const items = list.map((item) => {
          const isDir = Boolean(item.attrs.isDirectory && item.attrs.isDirectory());
          const isSym = Boolean(item.attrs.isSymbolicLink && item.attrs.isSymbolicLink());

          return {
            name: item.filename,
            path: path.posix.join(normalized, item.filename),
            size: item.attrs.size || 0,
            modifyTime: item.attrs.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
            permissions: formatPermissions(item.attrs.mode || 0),
            octalMode: (item.attrs.mode & 0o777).toString(8),
            isDirectory: isDir,
            isSymbolicLink: isSym,
            isFile: !isDir
          };
        });

        // Sort directories first, then alphabetically
        items.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        resolve({
          currentPath: normalized,
          parentPath: normalized === '/' ? null : path.posix.dirname(normalized),
          files: items
        });
      });
    });
  });
}

export async function readFileWithSftp(sftp, remotePath, maxBytes = 1024 * 1024 * 5) {
  const normalized = validateSafePath(remotePath);
  if (!sftp || typeof sftp.stat !== 'function' || typeof sftp.createReadStream !== 'function') {
    throw new TypeError('An active SFTP channel is required');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');

  return new Promise((resolve, reject) => {
    sftp.stat(normalized, (statErr, stats) => {
      if (statErr) return reject(statErr);

      if (stats.size > maxBytes) {
        return reject(new Error(`文件过大 (${(stats.size / 1024 / 1024).toFixed(2)} MB)，网页端直接查看限制在 ${formatByteLimit(maxBytes)} 以内，请通过下载查看。`));
      }

      const stream = sftp.createReadStream(normalized);
      const chunks = [];
      let receivedBytes = 0;
      let settled = false;
      let streamEnded = false;
      const cleanup = () => {
        stream.off('data', handleData);
        stream.off('error', handleError);
        stream.off('end', handleEnd);
        stream.off('close', handleClose);
      };
      const finish = (error, result = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };

      function handleData(chunk) {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > maxBytes) {
          finish(new Error(`文件读取超过 ${formatByteLimit(maxBytes)} 上限，操作已停止`));
          try { stream.destroy(); } catch (_) {}
          return;
        }
        chunks.push(buffer);
      }
      function handleError(error) {
        finish(error);
        try { stream.destroy(); } catch (_) {}
      }
      function handleEnd() {
        streamEnded = true;
        const buffer = Buffer.concat(chunks, receivedBytes);
        finish(null, {
          path: normalized,
          size: receivedBytes,
          content: buffer.toString('utf-8')
        });
      }
      function handleClose() {
        if (streamEnded || settled) return;
        const error = new Error('远程文件流在读取完成前已关闭');
        error.code = 'SFTP_STREAM_CLOSED';
        finish(error);
      }

      stream.on('data', handleData);
      stream.once('error', handleError);
      stream.once('end', handleEnd);
      stream.once('close', handleClose);
    });
  });
}

export async function readFile(remotePath, maxBytes = 1024 * 1024 * 5) {
  return withSftp((sftp) => readFileWithSftp(sftp, remotePath, maxBytes));
}

export function buildSftpWriteOptions(options = {}) {
  const exclusive = options.exclusive === true;
  const streamOptions = { flags: exclusive ? 'wx' : 'w' };
  if (options.mode !== undefined) {
    if (typeof options.mode === 'string' && !/^[0-7]{3,4}$/.test(options.mode)) {
      throw new Error(`非法文件权限模式: ${options.mode}`);
    }
    const mode = typeof options.mode === 'string'
      ? Number.parseInt(options.mode, 8)
      : options.mode;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new Error(`非法文件权限模式: ${options.mode}`);
    }
    streamOptions.mode = mode;
  }
  return streamOptions;
}

export function writeFileWithSftp(sftp, remotePath, content, options = {}) {
  const normalized = validateSafePath(remotePath);
  const streamOptions = buildSftpWriteOptions(options);
  if (!sftp || typeof sftp.createWriteStream !== 'function') {
    return Promise.reject(new TypeError('An active SFTP channel is required'));
  }

  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(normalized, streamOptions);
    let settled = false;
    let streamFinished = false;
    const cleanup = () => {
      stream.off('error', handleError);
      stream.off('finish', handleFinish);
      stream.off('close', handleClose);
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ success: true, path: normalized });
    };
    function handleError(error) { finish(error); }
    function handleFinish() {
      streamFinished = true;
      finish();
    }
    function handleClose() {
      if (streamFinished || settled) return;
      const error = new Error('远程文件写入在完成前已关闭');
      error.code = 'SFTP_STREAM_CLOSED';
      finish(error);
    }

    stream.once('error', handleError);
    stream.once('finish', handleFinish);
    stream.once('close', handleClose);
    try {
      stream.write(content, 'utf-8');
      stream.end();
    } catch (error) {
      finish(error);
      try { stream.destroy(); } catch (_) {}
    }
  });
}

export async function writeFile(remotePath, content, options = {}) {
  return withSftp((sftp) => writeFileWithSftp(sftp, remotePath, content, options));
}

export async function uploadLocalFile(localFilePath, remoteFilePath) {
  const normalized = validateSafePath(remoteFilePath);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.fastPut(localFilePath, normalized, (err) => {
        if (err) return reject(err);
        resolve({ success: true, path: normalized });
      });
    });
  });
}

export async function createDir(remotePath) {
  const normalized = validateSafePath(remotePath);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.mkdir(normalized, (err) => {
        if (err) return reject(err);
        resolve({ success: true, path: normalized });
      });
    });
  });
}

export async function removePath(remotePath, isDirectory = false) {
  const normalized = assertNotProtectedTopLevelSystemPath(remotePath, '永久删除');

  if (isDirectory) {
    const result = await executeCommand('rm', ['-rf', normalized]);
    if (!result.success) {
      throw new Error(result.stderr || '删除目录失败');
    }
    return { success: true };
  } else {
    return withSftp(async (sftp) => {
      return new Promise((resolve, reject) => {
        sftp.unlink(normalized, (err) => {
          if (err) return reject(err);
          resolve({ success: true });
        });
      });
    });
  }
}

export async function renamePath(oldPath, newPath) {
  const normalizedOld = validateSafePath(oldPath);
  const normalizedNew = validateSafePath(newPath);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.rename(normalizedOld, normalizedNew, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
}

export async function chmodPath(remotePath, mode) {
  const normalized = validateSafePath(remotePath);
  const cleanMode = String(mode || '').trim();
  if (!/^[0-7]{3,4}$/.test(cleanMode)) {
    throw new Error(`非法权限模式: ${mode}`);
  }
  const octal = Number.parseInt(cleanMode, 8);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.chmod(normalized, octal, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
}
