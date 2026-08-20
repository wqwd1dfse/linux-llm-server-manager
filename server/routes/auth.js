import { Router } from 'express';
import { getSafeConfig, saveConfig, getConfig, setRuntimeSshOverride } from '../config.js';
import { getConnectionStatus, getClient, disconnect, testConnection } from '../sshManager.js';
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

const router = Router();

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
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    res.cookie(SESSION_COOKIE_NAME, signed, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
      path: '/',
      maxAge: SESSION_TTL_MS
    });

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
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

  const authResult = authenticateUser(username, password, String(ip));
  if (!authResult.success) {
    return res.status(authResult.needsSetup ? 400 : 401).json({
      success: false,
      error: authResult.error,
      needsSetup: authResult.needsSetup
    });
  }

  const signed = signCookie(authResult.token);
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

  res.cookie(SESSION_COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
    maxAge: SESSION_TTL_MS
  });

  res.json({
    success: true,
    message: '登录成功',
    user: { username: authResult.username }
  });
});

// 4. Web Dashboard Logout (Requires Active Session / Clears Session)
router.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const signedToken = cookies[SESSION_COOKIE_NAME];
  const token = unsignCookie(signedToken);
  destroySession(token);

  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ success: true, message: '已安全退出登录' });
});

// 5. Test SSH connection (Authenticated)
router.post('/test', async (req, res) => {
  try {
    const { host, port, username, authType, password, privateKey, passphrase, profileId } = req.body;
    const currentConfig = getConfig();
    const storedProfile = profileId ? getProfile(profileId) : null;
    const baseConfig = storedProfile ? profileToConnectionConfig(storedProfile) : currentConfig;
    const effectivePassword = (password && password.trim().length > 0) ? password : baseConfig.password;

    const testResult = await testConnection({
      host: (host || baseConfig.host || '127.0.0.1').trim(),
      port: parseInt(port, 10) || baseConfig.port || 22,
      username: (username || baseConfig.username || 'root').trim(),
      authType: authType || baseConfig.authType || 'password',
      password: effectivePassword || '',
      privateKey: privateKey || baseConfig.privateKey || '',
      passphrase: passphrase || baseConfig.passphrase || ''
    });

    res.json(testResult);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Connect SSH & Optionally Save (Authenticated)
router.post('/connect', async (req, res) => {
  try {
    const {
      host, port, username, authType, password, privateKey, passphrase,
      remember, profileId, profileName
    } = req.body;
    const currentConfig = getConfig();
    const storedProfile = profileId ? getProfile(profileId) : null;
    const baseConfig = storedProfile ? profileToConnectionConfig(storedProfile) : currentConfig;

    const newSshConfig = {
      host: (host || baseConfig.host || '127.0.0.1').trim(),
      port: parseInt(port, 10) || baseConfig.port || 22,
      username: (username || baseConfig.username || 'root').trim(),
      authType: authType || baseConfig.authType || 'password'
    };

    if (password && password.trim().length > 0) newSshConfig.password = password;
    else if (baseConfig.password) newSshConfig.password = baseConfig.password;

    if (privateKey && privateKey.trim().length > 0) newSshConfig.privateKey = privateKey;
    else if (baseConfig.privateKey) newSshConfig.privateKey = baseConfig.privateKey;

    if (passphrase && passphrase.trim().length > 0) newSshConfig.passphrase = passphrase;
    else if (baseConfig.passphrase) newSshConfig.passphrase = baseConfig.passphrase;

    // Step 1: Test connection before saving anything
    const testRes = await testConnection(newSshConfig);
    if (!testRes.success) {
      return res.status(400).json({
        success: false,
        error: `连接验证失败: ${testRes.error || '无法连接到目标服务器'}`
      });
    }

    // Step 2: Establish active connection
    let savedProfile = null;
    if (remember !== false) {
      savedProfile = saveProfile({
        id: profileId,
        name: profileName,
        ...newSshConfig
      });
      saveConfig({ ...newSshConfig, activeProfileId: savedProfile.id });
    } else {
      setRuntimeSshOverride({ ...newSshConfig, activeProfileId: profileId || null });
    }

    disconnect();
    await getClient(true, newSshConfig);

    res.json({
      success: true,
      message: savedProfile ? `SSH 连接已建立并保存档案「${savedProfile.name}」` : 'SSH 连接已建立',
      status: getConnectionStatus(),
      config: getSafeConfig(),
      profile: savedProfile
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: `连接建立失败: ${err.message}`
    });
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
    const profile = getProfile(req.params.id);
    if (!profile) return res.status(404).json({ success: false, error: '服务器档案不存在' });

    const connectionConfig = profileToConnectionConfig(profile);
    const testResult = await testConnection(connectionConfig);
    if (!testResult.success) {
      return res.status(400).json({ success: false, error: `连接验证失败: ${testResult.error || '未知错误'}` });
    }

    saveConfig({ ...connectionConfig, activeProfileId: profile.id });
    disconnect();
    await getClient(true, connectionConfig);

    res.json({
      success: true,
      message: `已切换到「${profile.name}」`,
      status: getConnectionStatus(),
      config: getSafeConfig(),
      profile: listProfiles().find(item => item.id === profile.id)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: `切换服务器失败: ${err.message}` });
  }
});

router.delete('/profiles/:id', (req, res) => {
  try {
    const activeProfileId = getConfig().activeProfileId;
    if (activeProfileId === req.params.id) {
      return res.status(409).json({ success: false, error: '当前正在使用此服务器档案，请先切换到其他服务器' });
    }
    if (!deleteProfile(req.params.id)) {
      return res.status(404).json({ success: false, error: '服务器档案不存在' });
    }
    res.json({ success: true, message: '服务器档案已删除' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 8. Disconnect active SSH (Authenticated)
router.post('/disconnect', (req, res) => {
  disconnect();
  res.json({ success: true, message: '已断开 SSH 连接' });
});

export default router;
