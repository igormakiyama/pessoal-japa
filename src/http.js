// Mini-framework HTTP sem dependências: rotas, corpo de formulários, cookies,
// arquivos estáticos, sessão do admin assinada e limite de tentativas.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

// ---------------------------------------------------------------- rotas

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    }) + '/?$');
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  match(method, pathname) {
    const wanted = method === 'HEAD' ? 'GET' : method;
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== wanted) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          params[key] = m[i + 1];
        }
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// ---------------------------------------------------------------- requisição

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Corpo da requisição grande demais'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readForm(req) {
  return new URLSearchParams((await readBody(req)).toString('utf8'));
}

export async function readJson(req) {
  const text = (await readBody(req)).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '-';
}

export function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || config.baseUrl.startsWith('https://');
}

export function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

// Formulários enviados de outros sites são recusados (proteção contra CSRF).
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [req.headers.host, req.headers['x-forwarded-host']];
  try {
    allowed.push(new URL(config.baseUrl).host);
  } catch {
    // BASE_URL inválida: segue só com os cabeçalhos
  }
  return allowed.filter(Boolean).includes(host);
}

// ---------------------------------------------------------------- respostas

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function send(res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buffer.length, ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : buffer);
}

export function sendHtml(res, status, html, headers = {}) {
  send(res, status, String(html), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

export function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

export function redirect(res, location, status = 303, headers = {}) {
  send(res, status, '', { Location: location, 'Cache-Control': 'no-store', ...headers });
}

export function cookieHeader(name, value, { maxAge, secure, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Serve um arquivo de dentro de baseDir, sem permitir sair da pasta.
export function serveFile(req, res, baseDir, relativePath, { maxAge = 3600, download } = {}) {
  const base = path.resolve(baseDir);
  const file = path.resolve(base, '.' + path.sep + relativePath);
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': `public, max-age=${maxAge}`,
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
  send(res, 200, fs.readFileSync(file), headers);
  return true;
}

// ---------------------------------------------------------------- proteção

const hits = new Map();

// Limite simples por IP, em memória (evita spam de cadastro, de e-mails e chute de senha).
export function rateLimited(req, bucket, limit = 10, windowMs = 3600000) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => t > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10000) {
    for (const [k, times] of hits) if (!times.some((t) => t > now - windowMs)) hits.delete(k);
  }
  return false;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

// Sessão do administrador: cookie assinado com SESSION_SECRET. Trocar a senha invalida as sessões.
function sessionSignature(expires) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${config.adminEmail}|${expires}|${sha256(config.adminPassword).toString('hex')}`)
    .digest('base64url');
}

export const adminEnabled = () => Boolean(config.adminEmail && config.adminPassword && config.sessionSecret);

export function createAdminSession(days = 7) {
  const expires = Date.now() + days * 86400000;
  return `${expires}.${sessionSignature(expires)}`;
}

export function isAdmin(req) {
  if (!adminEnabled()) return false;
  const value = parseCookies(req).adm;
  if (!value) return false;
  const [expires, signature] = value.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return safeEqual(signature, sessionSignature(expires));
}
