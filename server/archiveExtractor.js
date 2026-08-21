import { executeCommand } from './sshManager.js';
import { validateSafePath } from './executor.js';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024 * 1024;
const SUPPORTED_ARCHIVE_PATTERN = /\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;

function boundedPositiveInteger(value, fallback, maximum) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function isSupportedArchivePath(filePath) {
  return SUPPORTED_ARCHIVE_PATTERN.test(String(filePath || ''));
}

export async function extractArchiveSafely(filePath, targetDir) {
  const archivePath = validateSafePath(filePath);
  const destination = validateSafePath(targetDir);
  if (!isSupportedArchivePath(archivePath)) {
    throw new Error('不支持的压缩包格式；仅支持 zip、tar、tar.gz、tgz、tar.bz2、tbz2、tar.xz 和 txz');
  }

  const maxEntries = boundedPositiveInteger(
    process.env.MAX_ARCHIVE_ENTRIES,
    DEFAULT_MAX_ENTRIES,
    100_000
  );
  const maxBytes = boundedPositiveInteger(
    process.env.MAX_ARCHIVE_EXPANDED_MB,
    DEFAULT_MAX_BYTES / 1024 / 1024,
    1024 * 1024
  ) * 1024 * 1024;

  const script = String.raw`
import os
import pathlib
import sys
import tarfile
import zipfile

archive_path, destination, max_entries_raw, max_bytes_raw = sys.argv[1:5]
max_entries = int(max_entries_raw)
max_bytes = int(max_bytes_raw)
destination_real = os.path.realpath(destination)
os.makedirs(destination_real, exist_ok=True)

def validate_name(name):
    if not isinstance(name, str) or not name or '\x00' in name:
        raise ValueError('archive contains an invalid empty or null-byte path')
    normalized = name.replace('\\', '/')
    pure = pathlib.PurePosixPath(normalized)
    if pure.is_absolute() or '..' in pure.parts:
        raise ValueError('archive path escapes the destination: ' + name)
    target = os.path.realpath(os.path.join(destination_real, *pure.parts))
    if os.path.commonpath([destination_real, target]) != destination_real:
        raise ValueError('archive path escapes the destination: ' + name)

def enforce_limits(entries, total_bytes):
    if entries > max_entries:
        raise ValueError('archive contains too many entries')
    if total_bytes > max_bytes:
        raise ValueError('archive expands beyond the configured size limit')

lower = archive_path.lower()
if lower.endswith('.zip'):
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        total = 0
        for entry in entries:
            validate_name(entry.filename)
            mode = (entry.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ValueError('archive symbolic links are not allowed: ' + entry.filename)
            total += max(0, entry.file_size)
            enforce_limits(len(entries), total)
        archive.extractall(destination_real)
else:
    with tarfile.open(archive_path, mode='r:*') as archive:
        entries = archive.getmembers()
        total = 0
        for entry in entries:
            validate_name(entry.name)
            if entry.issym() or entry.islnk() or entry.isdev() or entry.isfifo():
                raise ValueError('archive links and special files are not allowed: ' + entry.name)
            total += max(0, entry.size)
            enforce_limits(len(entries), total)
        archive.extractall(destination_real, members=entries)

print('EXTRACTED')
`.trim();

  const result = await executeCommand(
    'python3',
    ['-c', script, archivePath, destination, String(maxEntries), String(maxBytes)],
    { timeoutMs: 120_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 256 * 1024 }
  );
  if (!result.success || !result.stdout.includes('EXTRACTED')) {
    throw new Error(result.stderr || '安全解压失败');
  }

  return { archivePath, destination };
}
