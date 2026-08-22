import { Router } from 'express';
import { getSafeConfig, saveConfig, getConfig, setRuntimeSshOverride } from '../config.js';
import {
  assertSshTargetContext,
  getConnectionStatus,
  getClient,
  disconnect,
  runSshConnectionTransition,
  testConnection
} from '../sshManager.js';
import {
  deleteProfile,
  getProfile,
  listProfiles,
  profileToConnectionConfig,
  saveProfile
} from '../profileStore.js';
import {
  authenticateUser,
  createSession,
  destroySession,
  signCookie,
  unsignCookie,
  parseCookies,
  getSession,
  isPasswordSet,
  setInitialPassword,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS
} from '../auth.js';
import { validatePort } from '../executor.js';

const router = Router();

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure === true,
    path: '/',
    maxAge: SESSION_TTL_MS,
    priority: 'high'
  };

}
function normalizeConnectionText(value, fallback, label, maxLength) {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof candidate !== 'string') throw new Error(`${label} 必须为字符串`);
  const clean = candidate.trim();
  if (!clean) throw new Error(`${label} 不能为空`);
  if (clean.length > maxLength || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`${label} 过长或包含非法控制字符`);
  }
  return clean;
}

function normalizeConnectionPort(value, fallback) {
  const candidate = value === undefined || value === null || value === '' ? (fallback || 22) : value;
  return validatePort(candidate);
}

function normalizeAuthType(value, fallback = 'password') {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  if (!['password', 'key'].includes(candidate)) throw new Error('身份认证方式仅支持 password 或 key');
  return candidate;
}

function normalizeOptionalSecret(value, label, maxBytes) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label} 必须为字符串`);
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} 包含非法空字符或超过大小限制`);
  }
  return value;
}

function buildConnectionConfig(input, baseConfig) {
  const password = normalizeOptionalSecret(input.password, 'SSH 密码', 4096) || baseConfig.password || '';
  const privateKey = normalizeOptionalSecret(input.privateKey, 'SSH 私钥', 1024 * 1024) || baseConfig.privateKey || '';
  const passphrase = normalizeOptionalSecret(input.passphrase, '私钥口令', 4096) || baseConfig.passphrase || '';
  return {
    host: normalizeConnectionText(input.host, baseConfig.host || '127.0.0.1', '主机地址', 255),
    port: normalizeConnectionPort(input.port, baseConfig.port),
    username: normalizeConnectionText(input.username, baseConfig.username || 'root', 'SSH 用户名', 64),
    authType: normalizeAuthType(input.authType, baseConfig.authType),
    password, privateKey, passphrase
  };
}

function isLoopbackAddress(value) {
  const address = String(value || '').trim().replace(/^::ffff:/, '');
  return address === '::1' || address.startsWith('127.');
}

function isLoopbackRequest(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const forwardedHeader = String(req.headers.forwarded || '');
  if (forwardedHeader && !/for=(?:"?)(?:127\.|\[?::1\]?)/i.test(forwardedHeader)) {
    return false;
  }

  return [req.socket?.remoteAddress, req.ip, ...forwardedFor]
    .filter(Boolean)
    .every(isLoopbackAddress);
}

function connectionTransitionError(res, prefix, error) {
  const busy = error?.code === 'QUEUE_FULL' || error?.code === 'QUEUE_TIMEOUT';
  if (busy) res.setHeader('Retry-After', '1');
  return res.status(busy ? 429 : 400).json({
    success: false,
    error: busy ? 'SSH 连接切换繁忙，请稍后重试' : `${prefix}: ${error.message}`,
    status: getConnectionStatus(),
    config: getSafeConfig()
  });
}

// 1. Auth Status & System Setup State (Public)
const handleStatus = (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const signedToken = cookies[SESSION_COOKIE_NAME];
  const token = unsignCookie(signedToken);
  const session = getSession(token);

  if (!session) {
    return res.json({
      success: true,
      authenticated: false,
      user: null,
      needsSetup: !isPasswordSet()
    });
  }

  // If authenticated, also return SSH status and safe config
  const status = getConnectionStatus();
  const config = getSafeConfig();

  res.json({
    success: true,
    authenticated: true,
    user: session.user,
    needsSetup: !isPasswordSet(),
    connected: status.connected,
    status,
    config
  });
};

router.get('/status', handleStatus);
router.get('/auth-status', handleStatus);

// 2. Initial Setup (Set Admin Password & Optional Username) (Public)
router.post('/setup', (req, res) => {
  try {
    const remoteSetupAllowed = process.env.ALLOW_REMOTE_SETUP === 'true';
    if (!remoteSetupAllowed && !isLoopbackRequest(req)) {
      return res.status(403).json({
        success: false,
        error: '首次初始化仅允许从本机访问；如需远程初始化，请临时设置 ALLOW_REMOTE_SETUP=true'
      });
    }

    if (isPasswordSet()) {
      return res.status(400).json({ success: false, error: '管理员已完成初始化，无法重复设置。' });
    }

    const { password, username = 'admin' } = req.body;
    setInitialPassword(password, username);

    // Auto-login upon setup
    const token = createSession({ username: username.trim() || 'admin' });
    const signed = signCookie(token);
    res.cookie(SESSION_COOKIE_NAME, signed, sessionCookieOptions(req));

    res.json({
      success: true,
      message: '管理员初始化成功',
      user: { username: username.trim() || 'admin' }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Web Dashboard Login (Public)
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

    const authResult = await authenticateUser(username, password, String(ip));
    if (!authResult.success) {
      if (authResult.busy) {
        res.setHeader('Retry-After', String(authResult.retryAfterSeconds || 1));
      }
      const status = authResult.needsSetup ? 400 : (authResult.busy ? 503 : 401);
      return res.status(status).json({
        success: false,
        error: authResult.error,
        needsSetup: authResult.needsSetup,
        code: authResult.code
      });
    }

    const signed = signCookie(authResult.token);
    res.cookie(SESSION_COOKIE_NAME, signed, sessionCookieOptions(req));

    res.json({
      success: true,
      message: '登录成功',
      user: { username: authResult.username }
    });
  } catch (error) {
    next(error);
  }
});

// 4. Web Dashboard Logout (Requires Active Session / Clears Session)
router.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const signedToken = cookies[SESSION_COOKIE_NAME];
  const token = unsignCookie(signedToken);
  destroySession(token);

  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.setHeader('Clear-Site-Data', '"cache", "storage"');
  res.json({ success: true, message: '已安全退出登录' });
});

// 5. Test SSH connection (Authenticated)
router.post('/test', async (req, res) => {
  try {
    const { profileId } = req.body;
    const currentConfig = getConfig();
    const storedProfile = profileId ? getProfile(profileId) : null;
    const baseConfig = storedProfile ? profileToConnectionConfig(storedProfile) : currentConfig;
    const testResult = await testConnection(buildConnectionConfig(req.body, baseConfig));

    res.json(testResult);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Connect SSH & Optionally Save (Authenticated)
router.post('/connect', async (req, res) => {
  try {
    await runSshConnectionTransition(async () => {
      assertSshTargetContext(req.sshTargetContext);
      const { remember, profileId, profileName } = req.body;
      const currentConfig = getConfig();
      const storedProfile = profileId ? getProfile(profileId) : null;
      const baseConfig = storedProfile ? profileToConnectionConfig(storedProfile) : currentConfig;
      const newSshConfig = buildConnectionConfig(req.body, baseConfig);

      const testRes = await testConnection(newSshConfig);
      if (!testRes.success) {
        return res.status(400).json({
          success: false,
          error: `连接验证失败: ${testRes.error || '无法连接到目标服务器'}`,
          status: getConnectionStatus(),
          config: getSafeConfig()
        });
      }

      const requestedProfileId = profileId || null;
      await getClient(true, { ...newSshConfig, activeProfileId: remember === false ? requestedProfileId : null });

      let savedProfile = null;
      let persistenceWarning = null;
      if (remember !== false) {
        try {
          savedProfile = saveProfile({
            id: profileId,
            name: profileName,
            ...newSshConfig
          });
          saveConfig({ ...newSshConfig, activeProfileId: savedProfile.id });
        } catch (error) {
          // The transport is already active. Keep runtime config aligned with
          // that target and report persistence as a warning, not a failed switch.
          setRuntimeSshOverride({
            ...newSshConfig,
            activeProfileId: savedProfile?.id || null
          });
          persistenceWarning = `SSH 已连接，但服务器档案未能完整保存: ${error.message}`;
        }
      }

      return res.json({
        success: true,
        persisted: remember === false ? null : !persistenceWarning,
        message: persistenceWarning
          ? 'SSH 连接已建立，但档案保存失败；当前连接仍可安全使用'
          : (savedProfile ? `SSH 连接已建立并保存档案「${savedProfile.name}」` : 'SSH 连接已建立'),
        warning: persistenceWarning,
        status: getConnectionStatus(),
        config: getSafeConfig(),
        profile: savedProfile
      });
    });
  } catch (err) {
    return connectionTransitionError(res, '连接建立失败', err);
  }
});

// 7. Saved server profiles (Authenticated)
router.get('/profiles', (req, res) => {
  res.json({
    success: true,
    profiles: listProfiles(),
    activeProfileId: getConfig().activeProfileId || null
  });
});

router.post('/profiles/:id/connect', async (req, res) => {
  try {
    await runSshConnectionTransition(async () => {
      assertSshTargetContext(req.sshTargetContext);
      const profile = getProfile(req.params.id);
      if (!profile) return res.status(404).json({ success: false, error: '服务器档案不存在' });

      const connectionConfig = profileToConnectionConfig(profile);
      const testResult = await testConnection(connectionConfig);
      if (!testResult.success) {
        return res.status(400).json({
          success: false,
          error: `连接验证失败: ${testResult.error || '未知错误'}`,
          status: getConnectionStatus(),
          config: getSafeConfig()
        });
      }

      await getClient(true, { ...connectionConfig, activeProfileId: profile.id });

      let persistenceWarning = null;
      try {
        saveConfig({ ...connectionConfig, activeProfileId: profile.id });
      } catch (error) {
        setRuntimeSshOverride({ ...connectionConfig, activeProfileId: profile.id });
        persistenceWarning = `SSH 已连接，但活动档案状态未能写入配置文件: ${error.message}`;
      }

      return res.json({
        success: true,
        persisted: !persistenceWarning,
        message: persistenceWarning
          ? `已切换到「${profile.name}」，但活动档案状态未能持久化`
          : `已切换到「${profile.name}」`,
        warning: persistenceWarning,
        status: getConnectionStatus(),
        config: getSafeConfig(),
        profile: listProfiles().find(item => item.id === profile.id)
      });
    });
  } catch (err) {
    return connectionTransitionError(res, '切换服务器失败', err);
  }
});

router.delete('/profiles/:id', async (req, res) => {
  try {
    await runSshConnectionTransition(() => {
      assertSshTargetContext(req.sshTargetContext);
      const activeProfileId = getConfig().activeProfileId;
      if (activeProfileId === req.params.id) {
        return res.status(409).json({ success: false, error: '当前正在使用此服务器档案，请先切换到其他服务器' });
      }
      if (!deleteProfile(req.params.id)) {
        return res.status(404).json({ success: false, error: '服务器档案不存在' });
      }
      return res.json({ success: true, message: '服务器档案已删除' });
    });
  } catch (err) {
    return connectionTransitionError(res, '删除服务器档案失败', err);
  }
});

// 8. Disconnect active SSH (Authenticated)
router.post('/disconnect', async (req, res) => {
  try {
    await runSshConnectionTransition(() => {
      assertSshTargetContext(req.sshTargetContext);
      disconnect();
      return res.json({ success: true, message: '已断开 SSH 连接' });
    });
  } catch (error) {
    return connectionTransitionError(res, '断开 SSH 连接失败', error);
  }
});

export default router;
