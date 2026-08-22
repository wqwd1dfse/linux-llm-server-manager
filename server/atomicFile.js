import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

export function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function replaceFileAtomic(tempPath, filePath, fileSystem = fs) {
  // Modern Node uses the platform's replace-existing rename semantics for
  // files on the same volume. If a filesystem cannot provide that guarantee,
  // fail with the original destination intact instead of copying over it and
  // risking a partially-written credentials or configuration file.
  fileSystem.renameSync(tempPath, filePath);
}

export function writeFileAtomic(filePath, content, options = {}) {
  const encoding = options.encoding || 'utf8';
  const mode = options.mode ?? 0o600;
  ensureParentDirectory(filePath);

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let tempCreated = false;

  try {
    const fd = fs.openSync(tempPath, 'wx', mode);
    tempCreated = true;
    try {
      fs.writeFileSync(fd, content, { encoding });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    replaceFileAtomic(tempPath, filePath);
    tempCreated = false;

    try {
      fs.chmodSync(filePath, mode);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    if (tempCreated) {
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`[Storage] Unable to remove temporary file ${tempPath}: ${error.message}`);
        }
      }
    }
  }
}

export function writeJsonAtomic(filePath, value, options = {}) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('JSON value is not serializable');
  writeFileAtomic(filePath, `${serialized}\n`, options);
}
