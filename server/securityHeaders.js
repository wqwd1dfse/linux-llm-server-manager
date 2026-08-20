// Security Headers & Origin Verification Middleware

const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = allowedOriginsEnv
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export function applySecurityHeaders(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent framing/clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Isolate the administration surface from cross-origin windows/resources.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }


  // XSS protection legacy header
  res.setHeader('X-XSS-Protection', '1; mode=block');

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
    const isSameHost = (req.headers.host && (origin.endsWith(`//${req.headers.host}`) || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`));
    const isAllowed = isSameHost || allowedOrigins.includes(origin);

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    }

    if (req.method === 'OPTIONS') {
      return res.status(isAllowed ? 204 : 403).end();
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
    // If same host
    if (originUrl.host === host) return true;
    // Check whitelist
    if (allowedOrigins.includes(origin)) return true;
    return false;
  } catch (_) {
    return false;
  }
}
