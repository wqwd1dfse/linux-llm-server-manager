import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  listFiles,
  readFile,
  readFileWithSftp,
  writeFile,
  uploadLocalFile,
  createDir,
  removePath,
  renamePath,
  chmodPath,
  withSftp
} from '../sftpManager.js';
import { executeCommand } from '../sshManager.js';
import { assertNotProtectedTopLevelSystemPath, validateSafePath } from '../executor.js';
import { getConfig } from '../config.js';
import { extractArchiveSafely, isSupportedArchivePath } from '../archiveExtractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_TMP_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

if (fs.existsSync(UPLOAD_TMP_DIR)) {
  const uploadDirectoryStat = fs.lstatSync(UPLOAD_TMP_DIR);
  if (uploadDirectoryStat.isSymbolicLink() || !uploadDirectoryStat.isDirectory()) {
    throw new Error(`Unsafe upload temporary directory: ${UPLOAD_TMP_DIR}`);
  }
} else {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
}
try {
  // Multer's temporary files may contain credentials or model data. A private
  // parent directory keeps them unreadable to other local users even though
  // the storage engine uses the process umask for individual file modes.
  fs.chmodSync(UPLOAD_TMP_DIR, 0o700);
} catch (error) {
  if (process.platform !== 'win32') throw error;
}

function boundedEnvironmentInteger(value, fallback, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// Configurable upload limits (Default 512MB per file, max 10 files per batch)
const MAX_FILE_SIZE = boundedEnvironmentInteger(process.env.MAX_UPLOAD_FILE_MB, 512, 1, 10240) * 1024 * 1024;
const MAX_FILES = boundedEnvironmentInteger(process.env.MAX_UPLOAD_FILES, 10, 1, 100);
const PREVIEW_MIME_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
});

function cleanupUploadedFiles(files) {
  for (const file of files || []) {
    if (!file?.path) continue;
    try {
      fs.unlinkSync(file.path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[Upload] Failed to remove temporary file ${file.path}: ${error.message}`);
      }
    }
  }
}

function sanitizeUploadFilename(originalName) {
  const filename = path.posix.basename(String(originalName || '').replace(/\\/g, '/')).trim();
  if (!filename || filename === '.' || filename === '..' || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw new Error('上传文件名为空或包含非法控制字符');
  }
  if (Buffer.byteLength(filename, 'utf8') > 255) throw new Error('上传文件名超过 255 字节');
  return filename;
}

function buildContentDisposition(disposition, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES
  }
});

const router = Router();

export function pipeSftpFileToResponse(req, res, sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(remotePath);
    let settled = false;
    let streamEnded = false;

    const cleanup = () => {
      req.off('aborted', handleClientAbort);
      res.off('close', handleResponseClose);
      res.off('error', handleResponseError);
      res.off('finish', handleResponseFinish);
      stream.off('error', handleStreamError);
      stream.off('end', handleStreamEnd);
      stream.off('close', handleStreamClose);
    };
    const terminateStartedResponse = () => {
      if (!res.headersSent || res.writableEnded || res.destroyed) return;
      try {
        if (typeof res.destroy === 'function') res.destroy();
        else res.end();
      } catch (_) {}
    };
    const finish = (error = null, terminateResponse = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminateResponse) terminateStartedResponse();
      if (error) reject(error);
      else resolve();
    };
    const abortStream = () => {
      if (settled) return;
      const error = new Error('Client disconnected during remote file transfer');
      error.code = 'CLIENT_ABORTED';
      finish(error);
      try { stream.destroy(); } catch (_) {}
    };
    function handleClientAbort() { abortStream(); }
    function handleResponseClose() {
      if (!res.writableEnded) abortStream();
    }
    function handleResponseError() { abortStream(); }
    function handleResponseFinish() { finish(); }
    function handleStreamError(error) {
      finish(error, true);
      try { stream.destroy(); } catch (_) {}
    }
    function handleStreamEnd() { streamEnded = true; }
    function handleStreamClose() {
      if (streamEnded || settled) return;
      const error = new Error('Remote file stream closed before the transfer completed');
      error.code = 'SFTP_STREAM_CLOSED';
      finish(error, true);
    }

    req.once('aborted', handleClientAbort);
    res.once('close', handleResponseClose);
    res.once('error', handleResponseError);
    res.once('finish', handleResponseFinish);
    stream.once('error', handleStreamError);
    stream.once('end', handleStreamEnd);
    stream.once('close', handleStreamClose);
    stream.pipe(res);
  });
}

function validateTrashItemId(value) {
  const id = String(value || '').trim();
  if (!/^\d{13}-[a-f0-9]{8}$/.test(id)) throw new Error('回收站项目标识无效');
  return id;
}

async function getTrashDir() {
  const username = String(getConfig().username || 'root').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw new Error('当前 SSH 用户名格式无效');

  let homeDir = username === 'root' ? '/root' : `/home/${username}`;
  const passwdResult = await executeCommand('getent', ['passwd', username], { timeoutMs: 4000 });
  if (passwdResult.success && passwdResult.stdout) {
    const detectedHome = passwdResult.stdout.split(':')[5];
    if (detectedHome && detectedHome.startsWith('/')) homeDir = validateSafePath(detectedHome);
  }

  const trashDir = validateSafePath(path.posix.join(homeDir, '.server-manager-trash'));
  const mkdirResult = await executeCommand('mkdir', ['-p', trashDir], { timeoutMs: 5000 });
  if (!mkdirResult.success) throw new Error(mkdirResult.stderr || '无法创建远程回收站目录');
  return trashDir;
}

export async function movePathToTrash(targetPath, dependencies = {}) {
  const executeCommandFn = dependencies.executeCommandFn || executeCommand;
  const getTrashDirFn = dependencies.getTrashDirFn || getTrashDir;
  const writeFileFn = dependencies.writeFileFn || writeFile;
  const nowFn = dependencies.nowFn || Date.now;
  const randomBytesFn = dependencies.randomBytesFn || crypto.randomBytes;
  const cleanPath = assertNotProtectedTopLevelSystemPath(targetPath, '移入回收站');

  const trashDir = await getTrashDirFn();
  if (cleanPath === trashDir || cleanPath.startsWith(`${trashDir}/`)) {
    throw new Error('不能将回收站自身再次移入回收站');
  }

  const directoryCheck = await executeCommandFn('test', ['-d', cleanPath], { timeoutMs: 3000 });
  const detectedDirectory = directoryCheck.success;
  const id = `${nowFn()}-${randomBytesFn(4).toString('hex')}`;
  const itemPath = path.posix.join(trashDir, `${id}.item`);
  const metaPath = path.posix.join(trashDir, `${id}.meta.json`);

  const metadata = {
    id,
    originalPath: cleanPath,
    originalName: path.posix.basename(cleanPath),
    isDirectory: detectedDirectory,
    deletedAt: new Date().toISOString()
  };

  // Persist recovery information before moving the item. If the SSH target
  // changes or the transport drops during mv, an item that did move remains
  // discoverable instead of becoming an opaque orphan. A metadata-only entry
  // is harmless and is ignored by the trash listing until an item exists.
  await writeFileFn(metaPath, JSON.stringify(metadata), { mode: 0o600, exclusive: true });

  const moveResult = await executeCommandFn('mv', [cleanPath, itemPath], { timeoutMs: 30000 });
  if (!moveResult.success) throw new Error(moveResult.stderr || '移动到回收站失败');
  return metadata;
}

async function readTrashMetadata(trashDir, id, sftp = null) {
  const cleanId = validateTrashItemId(id);
  const metaPath = path.posix.join(trashDir, `${cleanId}.meta.json`);
  const itemPath = path.posix.join(trashDir, `${cleanId}.item`);
  const file = sftp
    ? await readFileWithSftp(sftp, metaPath, 64 * 1024)
    : await readFile(metaPath, 64 * 1024);
  const metadata = JSON.parse(file.content);
  if (metadata.id !== cleanId) throw new Error('回收站元数据校验失败');
  metadata.originalPath = validateSafePath(metadata.originalPath);
  return { metadata, metaPath, itemPath };
}

async function remotePathExists(targetPath, commandExecutor = executeCommand) {
  const result = await commandExecutor(
    'sh',
    ['-c', '[ -e "$1" ] || [ -L "$1" ]', 'sh', validateSafePath(targetPath)],
    { timeoutMs: 3000 }
  );
  if (result.success && result.code === 0) return true;
  if (!result.success && result.code === 1 && !result.timeout && !result.aborted) return false;
  const error = new Error(result.stderr || '无法确认远程路径是否存在');
  error.code = result.timeout ? 'REMOTE_PATH_CHECK_TIMEOUT' : 'REMOTE_PATH_CHECK_FAILED';
  throw error;
}

export async function restoreTrashItemPath(itemPath, originalPath, commandExecutor = executeCommand) {
  const cleanItemPath = validateSafePath(itemPath);
  const cleanOriginalPath = validateSafePath(originalPath);
  if (await remotePathExists(cleanOriginalPath, commandExecutor)) {
    return { restored: false, conflict: true };
  }

  const parentDir = path.posix.dirname(cleanOriginalPath);
  const mkdirResult = await commandExecutor('mkdir', ['-p', parentDir], { timeoutMs: 5000 });
  if (!mkdirResult.success) throw new Error(mkdirResult.stderr || '无法创建原目录');

  // GNU mv's no-clobber + no-target-directory flags close the gap between
  // the existence check and the move. Without -T, a concurrently-created
  // directory could also cause the item to be nested inside it unexpectedly.
  const moveResult = await commandExecutor(
    'mv',
    ['--no-clobber', '--no-target-directory', cleanItemPath, cleanOriginalPath],
    { timeoutMs: 30000 }
  );
  if (!moveResult.success) throw new Error(moveResult.stderr || '恢复失败');

  // GNU mv -n deliberately exits zero when it skips a conflicting target.
  // The source must therefore disappear before metadata can be removed.
  const sourceRemains = await remotePathExists(cleanItemPath, commandExecutor);
  return { restored: !sourceRemains, conflict: sourceRemains };
}

// 1. List directory
router.get('/list', async (req, res) => {
  try {
    const targetPath = validateSafePath(req.query.path || '/');
    const result = await listFiles(targetPath);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Read file content
router.get('/read', async (req, res) => {
  try {
    const filePath = validateSafePath(req.query.path);
    const result = await readFile(filePath);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Save file content
router.post('/save', async (req, res) => {
  try {
    const filePath = validateSafePath(req.body.path);
    const { content } = req.body;
    if (content === undefined) {
      return res.status(400).json({ success: false, error: '文件内容不能为空' });
    }
    await writeFile(filePath, content);
    res.json({ success: true, message: '文件已成功保存' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Image preview stream
router.get('/preview', async (req, res) => {
  try {
    const filePath = validateSafePath(req.query.path);
    const ext = path.posix.extname(filePath).toLowerCase();
    const contentType = PREVIEW_MIME_TYPES[ext];
    if (!contentType) {
      return res.status(415).json({ success: false, error: '该文件类型不支持浏览器内预览，请使用下载功能' });
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', buildContentDisposition('inline', path.posix.basename(filePath)));
    if (ext === '.svg') {
      // Remote SVG is active content. A sandboxed, opaque origin preserves
      // visual preview while preventing scripts from inheriting dashboard auth.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    }

    await withSftp(async (sftp) => {
      await pipeSftpFileToResponse(req, res, sftp, filePath);
    });
  } catch (err) {
    if (err.code === 'CLIENT_ABORTED') return;
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

// 5. Download file stream
router.get('/download', async (req, res) => {
  try {
    const filePath = validateSafePath(req.query.path);
    const filename = path.posix.basename(filePath);

    res.setHeader('Content-Disposition', buildContentDisposition('attachment', filename));
    res.setHeader('Content-Type', 'application/octet-stream');

    await withSftp(async (sftp) => {
      await pipeSftpFileToResponse(req, res, sftp, filePath);
    });
  } catch (err) {
    if (err.code === 'CLIENT_ABORTED') return;
    if (!res.headersSent) res.status(500).send(`下载失败: ${err.message}`);
  }
});

// 6. Upload multiple files with resource limit & cleanup
router.post('/upload', (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
      cleanupUploadedFiles([...(req.files || []), ...(req.file ? [req.file] : [])]);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: `上传文件体积超过单文件限制 (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(413).json({
          success: false,
          error: `单次上传文件数超过上限 (${MAX_FILES} 个)`
        });
      }
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  const uploadedFiles = req.files || [];
  let targetDir;
  try {
    targetDir = validateSafePath(req.body.targetDir || '/root');
  } catch (err) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, error: err.message });
  }

  if (uploadedFiles.length === 0 && req.file) {
    uploadedFiles.push(req.file);
  }

  if (uploadedFiles.length === 0) {
    return res.status(400).json({ success: false, error: '没有上传任何文件' });
  }

  const results = [];
  const errors = [];

  for (const file of uploadedFiles) {
    const localPath = file.path;
    let safeFilename = String(file.originalname || 'unnamed');
    try {
      safeFilename = sanitizeUploadFilename(file.originalname);
      const remotePath = path.posix.join(targetDir, safeFilename);
      await uploadLocalFile(localPath, remotePath);
      results.push(safeFilename);
    } catch (e) {
      errors.push(`${safeFilename}: ${e.message}`);
    } finally {
      cleanupUploadedFiles([file]);
    }
  }

  if (errors.length > 0 && results.length === 0) {
    return res.status(500).json({ success: false, error: errors.join(', ') });
  }

  res.json({
    success: true,
    message: `成功上传 ${results.length} 个文件${errors.length > 0 ? `，失败 ${errors.length} 个` : ''}`,
    files: results,
    errors: errors.length > 0 ? errors : undefined
  });
});

// 7. Create new directory
router.post('/mkdir', async (req, res) => {
  try {
    const dirPath = validateSafePath(req.body.path);
    await createDir(dirPath);
    res.json({ success: true, message: '目录创建成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Create new file
router.post('/create', async (req, res) => {
  try {
    const filePath = validateSafePath(req.body.path);
    await writeFile(filePath, '');
    res.json({ success: true, message: '文件创建成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Delete single file or folder (moves to remote trash by default)
router.post('/delete', async (req, res) => {
  try {
    const targetPath = validateSafePath(req.body.path);
    const isDirectory = Boolean(req.body.isDirectory);
    if (req.body.permanent === true) {
      await removePath(targetPath, isDirectory);
      return res.json({ success: true, message: '已永久删除' });
    }

    const item = await movePathToTrash(targetPath);
    res.json({ success: true, message: '已移入回收站', item });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Batch Delete
router.post('/batch-delete', async (req, res) => {
  try {
    const { paths } = req.body;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要删除的项目' });
    }
    if (paths.length > 200) {
      return res.status(400).json({ success: false, error: '单次最多移入回收站 200 个项目' });
    }

    const validatedPaths = paths.map(p => assertNotProtectedTopLevelSystemPath(p, '批量移入回收站'));

    const trashed = [];
    for (const itemPath of validatedPaths) {
      trashed.push(await movePathToTrash(itemPath));
    }

    res.json({ success: true, message: `已将 ${trashed.length} 个项目移入回收站`, items: trashed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. Remote trash management
router.get('/trash', async (req, res) => {
  try {
    const trashDir = await getTrashDir();
    const result = await listFiles(trashDir);
    const itemNames = new Set(result.files.map(file => file.name));
    const metadataFiles = result.files
      .filter(file => file.name.endsWith('.meta.json'))
      .filter(file => itemNames.has(`${file.name.replace(/\.meta\.json$/, '')}.item`))
      // IDs begin with a fixed-width millisecond timestamp, so filename order
      // gives the newest entries before applying the response cap.
      .sort((left, right) => right.name.localeCompare(left.name))
      .slice(0, 200);
    const items = [];

    await withSftp(async (sftp) => {
      for (const file of metadataFiles) {
        try {
          const id = file.name.replace(/\.meta\.json$/, '');
          const { metadata } = await readTrashMetadata(trashDir, id, sftp);
          items.push(metadata);
        } catch (_) {}
      }
    });

    items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    res.json({ success: true, data: { trashDir, items } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/trash/:id/restore', async (req, res) => {
  try {
    const trashDir = await getTrashDir();
    const { metadata, metaPath, itemPath } = await readTrashMetadata(trashDir, req.params.id);
    const restoreResult = await restoreTrashItemPath(itemPath, metadata.originalPath);
    if (restoreResult.conflict) {
      return res.status(409).json({ success: false, error: `原位置已存在同名项目: ${metadata.originalPath}` });
    }
    await removePath(metaPath, false);

    res.json({ success: true, message: `已恢复到 ${metadata.originalPath}`, item: metadata });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/trash/:id', async (req, res) => {
  try {
    const trashDir = await getTrashDir();
    const { metadata, metaPath, itemPath } = await readTrashMetadata(trashDir, req.params.id);
    await removePath(itemPath, Boolean(metadata.isDirectory));
    await removePath(metaPath, false);
    res.json({ success: true, message: '回收站项目已永久删除' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/trash', async (req, res) => {
  try {
    const trashDir = await getTrashDir();
    const result = await listFiles(trashDir);
    for (const file of result.files) {
      await removePath(file.path, file.isDirectory);
    }
    res.json({ success: true, message: '回收站已清空' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Copy
router.post('/copy', async (req, res) => {
  try {
    const source = validateSafePath(req.body.source);
    const destination = validateSafePath(req.body.destination);

    const result = await executeCommand('cp', ['-r', source, destination], { timeoutMs: 30000 });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || '复制操作失败' });
    }

    res.json({ success: true, message: '项目复制成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Move
router.post('/move', async (req, res) => {
  try {
    const source = assertNotProtectedTopLevelSystemPath(req.body.source, '移动');
    const destination = validateSafePath(req.body.destination);

    const result = await executeCommand('mv', [source, destination], { timeoutMs: 15000 });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || '移动操作失败' });
    }

    res.json({ success: true, message: '项目移动成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Rename
router.post('/rename', async (req, res) => {
  try {
    const oldPath = assertNotProtectedTopLevelSystemPath(req.body.oldPath, '重命名');
    const newPath = assertNotProtectedTopLevelSystemPath(req.body.newPath, '重命名为新路径');

    await renamePath(oldPath, newPath);
    res.json({ success: true, message: '重命名成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14. Chmod
router.post('/chmod', async (req, res) => {
  try {
    const targetPath = assertNotProtectedTopLevelSystemPath(req.body.path, '修改权限');
    const { mode, recursive } = req.body;
    if (!mode || !/^[0-7]{3,4}$/.test(String(mode))) {
      return res.status(400).json({ success: false, error: '权限参数格式不合法 (如 755 或 644)' });
    }

    if (recursive) {
      const result = await executeCommand('chmod', ['-R', String(mode), targetPath], { timeoutMs: 15000 });
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.stderr || '修改权限失败' });
      }
      res.json({ success: true, message: `权限已递归修改为 ${mode}` });
    } else {
      await chmodPath(targetPath, String(mode));
      res.json({ success: true, message: `权限已修改为 ${mode}` });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. Compress
router.post('/compress', async (req, res) => {
  try {
    const { targetDir, items, outputName, format } = req.body;
    const cleanDir = validateSafePath(targetDir);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: '缺少要压缩的项目' });
    }
    if (items.length > 500) {
      return res.status(400).json({ success: false, error: '单次最多压缩 500 个项目' });
    }

    const archiveName = (outputName || `archive_${Date.now()}.${format === 'zip' ? 'zip' : 'tar.gz'}`).replace(/[^\w\.\-]/g, '_');
    if (!archiveName || archiveName === '.' || archiveName === '..' || Buffer.byteLength(archiveName, 'utf8') > 255) {
      return res.status(400).json({ success: false, error: '压缩包名称无效或超过 255 字节' });
    }
    const safeItems = items.map(i => path.posix.basename(validateSafePath(i)));

    const archivePath = validateSafePath(path.posix.join(cleanDir, archiveName));
    let result;
    if (format === 'zip') {
      const zipScript = 'cd "$1" && shift && exec zip -r "$@"';
      result = await executeCommand(
        'sh',
        ['-c', zipScript, 'sh', cleanDir, archiveName, ...safeItems],
        { timeoutMs: 60000 }
      );
    } else {
      result = await executeCommand(
        'tar',
        ['-czvf', archivePath, '-C', cleanDir, ...safeItems],
        { timeoutMs: 60000 }
      );
    }

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || '压缩操作失败' });
    }

    res.json({ success: true, message: `压缩完成: ${archiveName}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 16. Extract
router.post('/extract', async (req, res) => {
  try {
    const { filePath, targetDir } = req.body;
    const cleanPath = validateSafePath(filePath);
    const dest = validateSafePath(targetDir || path.posix.dirname(cleanPath));
    if (!isSupportedArchivePath(cleanPath)) {
      return res.status(400).json({ success: false, error: '不支持的压缩包格式' });
    }
    await extractArchiveSafely(cleanPath, dest);

    res.json({ success: true, message: '解压已成功完成' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 17. Search
router.post('/search', async (req, res) => {
  try {
    const { path: searchDir, keyword } = req.body;
    const cleanDir = validateSafePath(searchDir);
    const cleanKeyword = typeof keyword === 'string' ? keyword.trim() : '';
    if (!cleanKeyword) {
      return res.status(400).json({ success: false, error: '搜索关键字不能为空' });
    }
    if (cleanKeyword.length > 128 || /[\u0000\r\n]/.test(cleanKeyword)) {
      return res.status(400).json({ success: false, error: '搜索关键字过长或包含非法控制字符' });
    }

    const result = await executeCommand(
      'find',
      [cleanDir, '-maxdepth', '3', '-iname', `*${cleanKeyword}*`, '-printf', '%y\t%p\n'],
      { timeoutMs: 8000, maxStdoutBytes: 512 * 1024 }
    );
    if (!result.success && !result.stdout) {
      return res.status(400).json({ success: false, error: result.stderr || '搜索失败' });
    }

    const lines = (result.stdout || '').trim().split('\n').filter(Boolean).slice(0, 80);
    const matches = lines.map((line) => {
      const separator = line.indexOf('\t');
      const type = separator >= 0 ? line.slice(0, separator) : '';
      const matchPath = separator >= 0 ? line.slice(separator + 1) : line;
      return { path: matchPath, name: path.posix.basename(matchPath), isDirectory: type === 'd' };
    });

    res.json({ success: true, results: matches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 18. Properties
router.get('/properties', async (req, res) => {
  try {
    const cleanPath = validateSafePath(req.query.path);
    const duRes = await executeCommand('du', ['-sh', cleanPath], { timeoutMs: 5000 });
    const statRes = await executeCommand('stat', ['-c', '%a %U %G %s %y', cleanPath], { timeoutMs: 5000 });

    const duSize = (duRes.stdout || '').trim().split(/\s+/)[0] || '--';
    const statParts = (statRes.stdout || '').trim().split(/\s+/) || [];

    res.json({
      success: true,
      data: {
        path: cleanPath,
        name: path.posix.basename(cleanPath),
        diskSize: duSize,
        octalPerm: statParts[0] || '--',
        owner: statParts[1] || '--',
        group: statParts[2] || '--',
        exactBytes: parseInt(statParts[3], 10) || 0,
        modifyTime: statParts.slice(4).join(' ') || '--'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
