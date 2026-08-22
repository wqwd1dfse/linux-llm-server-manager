import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, '127.0.0.1');
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

async function reserveConsecutivePorts() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const basePort = 40000 + Math.floor(Math.random() * 8000);
    const first = net.createServer();
    const second = net.createServer();
    const probe = net.createServer();

    try {
      await listen(first, basePort);
      await listen(second, basePort + 1);
      await listen(probe, basePort + 2);
      await closeServer(probe);
      return { basePort, blockers: [first, second] };
    } catch (_) {
      await Promise.all([closeServer(first), closeServer(second), closeServer(probe)]);
    }
  }
  throw new Error('Unable to reserve three consecutive ports for the startup test');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

test('Server startup initializes runtime once after occupied-port retries', { timeout: 15000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'manager-startup-'));
  const { basePort, blockers } = await reserveConsecutivePorts();
  let child;

  t.after(async () => {
    if (child) await stopChild(child);
    await Promise.all(blockers.map(closeServer));
    await rm(tempDir, { recursive: true, force: true });
  });

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTO_CONNECT: 'false',
      CONFIG_FILE_PATH: path.join(tempDir, 'config.json'),
      HOST: '127.0.0.1',
      PORT: String(basePort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  const finalUrl = `http://127.0.0.1:${basePort + 2}`;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for server startup. Output:\n${output}`)), 10000);
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.includes(finalUrl)) {
        clearTimeout(timeout);
        setTimeout(resolve, 200);
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!output.includes(finalUrl)) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}. Output:\n${output}`));
      }
    });
  });

  assert.match(output, new RegExp(`Port ${basePort} is in use, trying port ${basePort + 1}`));
  assert.match(output, new RegExp(`Port ${basePort + 1} is in use, trying port ${basePort + 2}`));
  assert.equal((output.match(/Linux \/ LLM Server Management Dashboard/g) || []).length, 1);
  assert.equal((output.match(/Local URL:/g) || []).length, 1);
  assert.equal((output.match(/Attempting initial connection/g) || []).length, 0);
});

test('Server startup fails clearly after the bounded port fallback limit', { timeout: 15000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'manager-startup-limit-'));
  const { basePort, blockers } = await reserveConsecutivePorts();
  let child;

  t.after(async () => {
    if (child) await stopChild(child);
    await Promise.all(blockers.map(closeServer));
    await rm(tempDir, { recursive: true, force: true });
  });

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTO_CONNECT: 'false',
      CONFIG_FILE_PATH: path.join(tempDir, 'config.json'),
      HOST: '127.0.0.1',
      PORT: String(basePort),
      PORT_FALLBACK_LIMIT: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const [exitCode] = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for bounded startup failure. Output:\n${output}`)), 10000);
    child.once('exit', (...args) => {
      clearTimeout(timeout);
      resolve(args);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  assert.equal(exitCode, 1);
  assert.match(output, new RegExp(`Port ${basePort} is in use, trying port ${basePort + 1}`));
  assert.match(output, /Server failed to start:/);
  assert.doesNotMatch(output, new RegExp(`trying port ${basePort + 2}`));
});

test('Server shutdown has a bounded grace period for active HTTP connections', () => {
  const source = readFileSync(path.join(projectRoot, 'server/index.js'), 'utf8');
  assert.match(source, /SHUTDOWN_GRACE_MS = boundedEnvironmentInteger/);
  assert.match(source, /server\.closeAllConnections\?\.\(\)/);
  assert.match(source, /clearTimeout\(forceCloseTimer\)/);
});
