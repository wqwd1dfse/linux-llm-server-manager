// Security Headers & Origin Verification Middleware

const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = allowedOriginsEnv
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isSameHostOrigin(origin, host) {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host;
  } catch (_) {
    return false;
  }
}

export function applySecurityHeaders(req, res, next) {
  const requestPath = typeof req.path === 'string' ? req.path : '';
  const requestMethod = String(req.method || 'GET').toUpperCase();
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent framing/clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Isolate the administration surface from cross-origin windows/resources.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Administrative API responses may contain host inventory, paths and
  // credentials metadata. They must never be retained by shared/browser caches.
  if (requestPath.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
  }

  if (req.secure === true) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Disable the obsolete browser XSS auditor; CSP is authoritative.
  res.setHeader('X-XSS-Protection', '0');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Content Security Policy
  // Scripts use external files and delegated event handlers; inline handlers stay disabled.
  const cspDirectives = [
    "object-src 'none'",
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss: https://hf-mirror.com https://huggingface.co",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');

  res.setHeader('Content-Security-Policy', cspDirectives);

  // Handle CORS
  const origin = req.headers.origin;
  if (origin) {
    const isSameHost = isSameHostOrigin(origin, req.headers.host);
    const isAllowed = isSameHost || allowedOrigins.includes(origin);
    res.setHeader('Vary', 'Origin');

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    }

    if (requestMethod === 'OPTIONS') {
      return res.status(isAllowed ? 204 : 403).end();
    }

    const isUnsafeApiRequest = requestPath.startsWith('/api/') && !['GET', 'HEAD'].includes(requestMethod);
    if (isUnsafeApiRequest && !isAllowed) {
      return res.status(403).json({ success: false, error: 'Request origin is not allowed' });
    }
  } else if (requestPath.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(requestMethod)) {
    // Modern browsers send Sec-Fetch-Site even when an Origin header is
    // omitted. Reject sibling-site and cross-site form submissions while
    // preserving CLI/API clients that do not send browser fetch metadata.
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
      return res.status(403).json({ success: false, error: 'Cross-site request is not allowed' });
    }
  }

  next();
}

export function verifyWebSocketOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin) return true; // Non-browser clients or direct ws connections

  try {
    const originUrl = new URL(origin);
    if (!['http:', 'https:'].includes(originUrl.protocol)) return false;
    // If same host
    if (originUrl.host === host) return true;
    // Check whitelist
    if (allowedOrigins.includes(origin)) return true;
    return false;
  } catch (_) {
    return false;
  }
}
