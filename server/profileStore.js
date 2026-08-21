import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic } from './atomicFile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const DEFAULT_PROFILES_PATH = path.join(DATA_DIR, 'servers.json');

export function getProfilesFilePath() {
  return process.env.SERVER_PROFILES_FILE || DEFAULT_PROFILES_PATH;
}

function ensureDataDir(filePath = getProfilesFilePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readStore(options = {}) {
  const profilesPath = getProfilesFilePath();
  ensureDataDir(profilesPath);
  if (!fs.existsSync(profilesPath)) return { version: 1, profiles: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.profiles)) {
      throw new Error('servers.json must contain a profiles array');
    }
    return {
      version: 1,
      profiles: parsed.profiles
    };
  } catch (err) {
    console.error('[Profiles] Failed to read servers.json:', err.message);
    if (options.throwOnError) throw new Error(`服务器档案文件无法解析，已停止覆盖: ${err.message}`);
    return { version: 1, profiles: [] };
  }
}

function writeStore(store) {
  const profilesPath = getProfilesFilePath();
  ensureDataDir(profilesPath);
  writeJsonAtomic(profilesPath, store, { encoding: 'utf8', mode: 0o600 });
}

function cleanText(value, maxLength = 128) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeProfile(input, existing = {}) {
  const host = cleanText(input.host ?? existing.host, 255);
  const username = cleanText(input.username ?? existing.username, 64);
  const port = Number(input.port ?? existing.port);
  const requestedAuthType = input.authType ?? existing.authType ?? 'password';
  const authType = requestedAuthType === 'key' ? 'key' : 'password';
  if (!host) throw new Error('主机地址不能为空');
  if (!username) throw new Error('用户名不能为空');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间');

  const now = new Date().toISOString();
  const profile = {
    id: existing.id || crypto.randomUUID(),
    name: cleanText(input.name ?? existing.name, 64) || `${username}@${host}`,
    label: cleanText(input.label ?? existing.label, 64),
    host,
    port,
    username,
    authType,
    password: input.password !== undefined && input.password !== '' ? String(input.password) : (existing.password || ''),
    privateKey: input.privateKey !== undefined && input.privateKey !== '' ? String(input.privateKey) : (existing.privateKey || ''),
    passphrase: input.passphrase !== undefined && input.passphrase !== '' ? String(input.passphrase) : (existing.passphrase || ''),
    createdAt: existing.createdAt || now,
    updatedAt: now
  };

  if (profile.authType === 'password' && !profile.password) throw new Error('密码认证档案缺少密码');
  if (profile.authType === 'key' && !profile.privateKey) throw new Error('私钥认证档案缺少私钥');
  return profile;
}

function toSafeProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    label: profile.label,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType: profile.authType,
    hasPassword: Boolean(profile.password),
    hasPrivateKey: Boolean(profile.privateKey),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

export function listProfiles() {
  return readStore().profiles.map(toSafeProfile);
}

export function getProfile(profileId) {
  const id = cleanText(profileId, 64);
  const profile = readStore().profiles.find(item => item.id === id);
  return profile ? { ...profile } : null;
}

export function saveProfile(input) {
  const store = readStore({ throwOnError: true });
  const requestedId = cleanText(input.id, 64);
  const index = requestedId ? store.profiles.findIndex(item => item.id === requestedId) : -1;
  const existing = index >= 0 ? store.profiles[index] : {};
  const profile = normalizeProfile(input, existing);

  if (index >= 0) store.profiles[index] = profile;
  else store.profiles.push(profile);
  writeStore(store);
  return toSafeProfile(profile);
}

export function deleteProfile(profileId) {
  const store = readStore({ throwOnError: true });
  const id = cleanText(profileId, 64);
  const nextProfiles = store.profiles.filter(item => item.id !== id);
  if (nextProfiles.length === store.profiles.length) return false;
  writeStore({ ...store, profiles: nextProfiles });
  return true;
}

export function profileToConnectionConfig(profile) {
  if (!profile) throw new Error('服务器档案不存在');
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType: profile.authType,
    password: profile.password || '',
    privateKey: profile.privateKey || '',
    passphrase: profile.passphrase || ''
  };
}
