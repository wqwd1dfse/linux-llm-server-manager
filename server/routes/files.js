import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  listFiles,
  readFile,
  writeFile,
  uploadLocalFile,
  createDir,
  removePath,
  renamePath,
  chmodPath,
  withSftp
} from '../sftpManager.js';
import { executeCommand } from '../sshManager.js';
import { validateSafePath } from '../executor.js';
import { getConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOAD_TMP_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');

if (!fs.existsSync(UPLOAD_TMP_DIR)) {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
}

// Configurable upload limits (Default 512MB per file, max 10 files per batch)
const MAX_FILE_SIZE = (parseInt(process.env.MAX_UPLOAD_FILE_MB, 10) || 512) * 1024 * 1024;
const MAX_FILES = parseInt(process.env.MAX_UPLOAD_FILES, 10) || 10;

const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES
  }
});

const router = Router();

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

async function movePathToTrash(targetPath) {
  const cleanPath = validateSafePath(targetPath);
  const protectedPaths = ['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/proc', '/root', '/sys', '/usr', '/var'];
  if (protectedPaths.includes(cleanPath)) {
    throw new Error(`安全限制：禁止移动系统关键目录 ${cleanPath} 到回收站`);
  }

  const trashDir = await getTrashDir();
  if (cleanPath === trashDir || cleanPath.startsWith(`${trashDir}/`)) {
    throw new Error('不能将回收站自身再次移入回收站');
  }

  const directoryCheck = await executeCommand('test', ['-d', cleanPath], { timeoutMs: 3000 });
  const detectedDirectory = directoryCheck.success;
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const itemPath = path.posix.join(trashDir, `${id}.item`);
  const metaPath = path.posix.join(trashDir, `${id}.meta.json`);
  const moveResult = await executeCommand('mv', [cleanPath, itemPath], { timeoutMs: 30000 });
  if (!moveResult.success) throw new Error(moveResult.stderr || '移动到回收站失败');

  const metadata = {
    id,
    originalPath: cleanPath,
    originalName: path.posix.basename(cleanPath),
    isDirectory: detectedDirectory,
    deletedAt: new Date().toISOString()
  };

  try {
    await writeFile(metaPath, JSON.stringify(metadata));
  } catch (err) {
    await executeCommand('mv', [itemPath, cleanPath], { timeoutMs: 30000 }).catch(() => {});
    throw err;
  }
  return metadata;
}

async function readTrashMetadata(trashDir, id) {
  const cleanId = validateTrashItemId(id);
  const metaPath = path.posix.join(trashDir, `${cleanId}.meta.json`);
  const itemPath = path.posix.join(trashDir, `${cleanId}.item`);
  const file = await readFile(metaPath, 64 * 1024);
  const metadata = JSON.parse(file.content);
  if (metadata.id !== cleanId) throw new Error('回收站元数据校验失败');
  metadata.originalPath = validateSafePath(metadata.originalPath);
  return { metadata, metaPath, itemPath };
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
    const mimeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf'
    };

    const contentType = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    await withSftp(async (sftp) => {
      return new Promise((resolve, reject) => {
        const stream = sftp.createReadStream(filePath);
        stream.on('error', (err) => {
          if (!res.headersSent) res.status(500).send(err.message);
          reject(err);
        });
        stream.on('end', () => resolve());
        stream.pipe(res);
      });
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

// 5. Download file stream
router.get('/download', async (req, res) => {
  try {
    const filePath = validateSafePath(req.query.path);
    const filename = path.posix.basename(filePath);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    await withSftp(async (sftp) => {
      return new Promise((resolve, reject) => {
        const readStream = sftp.createReadStream(filePath);
        readStream.on('error', (err) => {
          if (!res.headersSent) res.status(500).send(`下载失败: ${err.message}`);
          reject(err);
        });
        readStream.on('end', () => resolve());
        readStream.pipe(res);
      });
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).send(`下载失败: ${err.message}`);
  }
});

// 6. Upload multiple files with resource limit & cleanup
router.post('/upload', (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (err) {
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
    for (const file of uploadedFiles) {
      if (file.path && fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch (_) {}
      }
    }
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
    const safeFilename = path.posix.basename(file.originalname.replace(/\\/g, '/'));
    const remotePath = path.posix.join(targetDir, safeFilename);

    try {
      await uploadLocalFile(localPath, remotePath);
      results.push(safeFilename);
    } catch (e) {
      errors.push(`${safeFilename}: ${e.message}`);
    } finally {
      if (fs.existsSync(localPath)) {
        try { fs.unlinkSync(localPath); } catch (_) {}
      }
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

    const validatedPaths = paths.map(p => validateSafePath(p));
    if (validatedPaths.some(p => p === '/' || p === '/root' || p === '/home')) {
      return res.status(400).json({ success: false, error: '安全限制：包含系统关键根目录，禁止批量删除' });
    }

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
    const metadataFiles = result.files.filter(file => file.name.endsWith('.meta.json'));
    const items = [];

    for (const file of metadataFiles.slice(0, 200)) {
      try {
        const id = file.name.replace(/\.meta\.json$/, '');
        const { metadata } = await readTrashMetadata(trashDir, id);
        if (!itemNames.has(`${id}.item`)) continue;
        items.push(metadata);
      } catch (_) {}
    }

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
    const existsResult = await executeCommand('test', ['-e', metadata.originalPath], { timeoutMs: 3000 });
    if (existsResult.success) {
      return res.status(409).json({ success: false, error: `原位置已存在同名项目: ${metadata.originalPath}` });
    }

    const parentDir = path.posix.dirname(metadata.originalPath);
    const mkdirResult = await executeCommand('mkdir', ['-p', parentDir], { timeoutMs: 5000 });
    if (!mkdirResult.success) throw new Error(mkdirResult.stderr || '无法创建原目录');

    const moveResult = await executeCommand('mv', [itemPath, metadata.originalPath], { timeoutMs: 30000 });
    if (!moveResult.success) throw new Error(moveResult.stderr || '恢复失败');
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
    const source = validateSafePath(req.body.source);
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
    const oldPath = validateSafePath(req.body.oldPath);
    const newPath = validateSafePath(req.body.newPath);

    await renamePath(oldPath, newPath);
    res.json({ success: true, message: '重命名成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14. Chmod
router.post('/chmod', async (req, res) => {
  try {
    const targetPath = validateSafePath(req.body.path);
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

    const archiveName = (outputName || `archive_${Date.now()}.${format === 'zip' ? 'zip' : 'tar.gz'}`).replace(/[^\w\.\-]/g, '_');
    const safeItems = items.map(i => path.posix.basename(validateSafePath(i)));

    const archivePath = path.posix.join(cleanDir, archiveName);
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

    let result;
    if (cleanPath.endsWith('.zip')) {
      result = await executeCommand('unzip', ['-o', cleanPath, '-d', dest], { timeoutMs: 60000 });
    } else if (cleanPath.endsWith('.tar.bz2') || cleanPath.endsWith('.tbz2')) {
      result = await executeCommand('tar', ['-xjvf', cleanPath, '-C', dest], { timeoutMs: 60000 });
    } else {
      result = await executeCommand('tar', ['-xvf', cleanPath, '-C', dest], { timeoutMs: 60000 });
    }

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.stderr || '解压操作失败' });
    }

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
    if (!keyword || typeof keyword !== 'string') {
      return res.status(400).json({ success: false, error: '搜索关键字不能为空' });
    }

    const cleanKey = `*${keyword.trim().replace(/[^\w\.\-\*\?]/g, '')}*`;
    const result = await executeCommand('find', [cleanDir, '-maxdepth', '3', '-iname', cleanKey], { timeoutMs: 8000 });

    const lines = (result.stdout || '').trim().split('\n').filter(Boolean).slice(0, 80);
    const matches = lines.map(p => ({
      path: p,
      name: path.posix.basename(p),
      isDirectory: !path.posix.extname(p)
    }));

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
