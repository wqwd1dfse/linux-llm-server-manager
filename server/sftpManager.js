import { getSftp, executeCommand } from './sshManager.js';
import { validateSafePath } from './executor.js';
import path from 'path';

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
export async function withSftp(operation) {
  const sftp = await getSftp();
  try {
    return await operation(sftp);
  } finally {
    try {
      sftp.end();
    } catch (_) {}
  }
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

export async function readFile(remotePath, maxBytes = 1024 * 1024 * 5) {
  const normalized = validateSafePath(remotePath);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.stat(normalized, (statErr, stats) => {
        if (statErr) return reject(statErr);

        if (stats.size > maxBytes) {
          return reject(new Error(`文件过大 (${(stats.size / 1024 / 1024).toFixed(2)} MB)，网页端直接查看限制在 5MB 以内，请通过下载查看。`));
        }

        const stream = sftp.createReadStream(normalized);
        const chunks = [];

        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            path: normalized,
            size: stats.size,
            content: buffer.toString('utf-8')
          });
        });
      });
    });
  });
}

export async function writeFile(remotePath, content) {
  const normalized = validateSafePath(remotePath);

  return withSftp(async (sftp) => {
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(normalized, { flags: 'w' });
      stream.on('error', (err) => reject(err));
      stream.on('finish', () => {
        resolve({ success: true, path: normalized });
      });

      stream.write(content, 'utf-8');
      stream.end();
    });
  });
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
  const normalized = validateSafePath(remotePath);

  // Safety guard against root or essential system directories
  if (['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sys', '/usr', '/var'].includes(normalized)) {
    throw new Error(`安全限制：禁止删除系统核心目录 ${normalized}`);
  }

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
