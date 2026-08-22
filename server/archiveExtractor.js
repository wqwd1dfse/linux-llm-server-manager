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
import tempfile
import sys
import tarfile
import zipfile

archive_path, destination, max_entries_raw, max_bytes_raw = sys.argv[1:5]
max_entries = int(max_entries_raw)
max_bytes = int(max_bytes_raw)
destination_real = os.path.realpath(destination)
os.makedirs(destination_real, exist_ok=True)

actual_bytes = 0

def validated_target(name):
    if not isinstance(name, str) or not name or '\x00' in name:
        raise ValueError('archive contains an invalid empty or null-byte path')
    normalized = name.replace('\\', '/')
    pure = pathlib.PurePosixPath(normalized)
    if pure.is_absolute() or '..' in pure.parts:
        raise ValueError('archive path escapes the destination: ' + name)
    target = os.path.realpath(os.path.join(destination_real, *pure.parts))
    if os.path.commonpath([destination_real, target]) != destination_real:
        raise ValueError('archive path escapes the destination: ' + name)
    return target

def enforce_limits(entries, total_bytes):
    if entries > max_entries:
        raise ValueError('archive contains too many entries')
    if total_bytes > max_bytes:
        raise ValueError('archive expands beyond the configured size limit')

def ensure_directory(target):
    os.makedirs(target, exist_ok=True)
    resolved = os.path.realpath(target)
    if os.path.commonpath([destination_real, resolved]) != destination_real:
        raise ValueError('archive directory escapes the destination: ' + target)

def write_stream(source, target, mode=0o644):
    global actual_bytes
    parent = os.path.dirname(target)
    ensure_directory(parent)
    parent_real = os.path.realpath(parent)
    if os.path.commonpath([destination_real, parent_real]) != destination_real:
        raise ValueError('archive file parent escapes the destination: ' + target)

    fd, temporary = tempfile.mkstemp(prefix='.server-manager-extract-', dir=parent_real)
    try:
        with os.fdopen(fd, 'wb') as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                actual_bytes += len(chunk)
                if actual_bytes > max_bytes:
                    raise ValueError('archive expands beyond the configured size limit while extracting')
                output.write(chunk)
        os.chmod(temporary, mode & 0o777 or 0o644)
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

lower = archive_path.lower()
if lower.endswith('.zip'):
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        total = 0
        for entry in entries:
            validated_target(entry.filename)
            raw_mode = (entry.external_attr >> 16)
            file_type = raw_mode & 0o170000
            if file_type not in (0, 0o040000, 0o100000):
                raise ValueError('archive links and special files are not allowed: ' + entry.filename)
            total += max(0, entry.file_size)
            enforce_limits(len(entries), total)
        for entry in entries:
            target = validated_target(entry.filename)
            if entry.is_dir():
                ensure_directory(target)
                continue
            with archive.open(entry, 'r') as source:
                write_stream(source, target, (entry.external_attr >> 16) & 0o777)
else:
    with tarfile.open(archive_path, mode='r:*') as archive:
        entries = archive.getmembers()
        total = 0
        for entry in entries:
            validated_target(entry.name)
            if entry.issym() or entry.islnk() or entry.isdev() or entry.isfifo():
                raise ValueError('archive links and special files are not allowed: ' + entry.name)
            if not entry.isdir() and not entry.isfile():
                raise ValueError('archive contains an unsupported entry type: ' + entry.name)
            total += max(0, entry.size)
            enforce_limits(len(entries), total)
        for entry in entries:
            target = validated_target(entry.name)
            if entry.isdir():
                ensure_directory(target)
                continue
            source = archive.extractfile(entry)
            if source is None:
                raise ValueError('archive file could not be read: ' + entry.name)
            with source:
                write_stream(source, target, entry.mode)

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
