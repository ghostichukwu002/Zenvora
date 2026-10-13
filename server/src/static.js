// Serves the browser app from the web/ folder. No build step, no dependencies.
// Paths are resolved against the web root and rejected if they escape it.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// A conservative policy: the app loads only its own scripts and styles,
// and never runs inline script. Inline styles are avoided in the JS too.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

export function resolveStaticPath(webRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const root = resolve(webRoot);
  const target = normalize(join(root, decoded === '/' ? 'index.html' : decoded));
  // The target must sit inside the web root, not merely share its prefix.
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

export async function serveStatic(req, res, pathname, webRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  const filePath = resolveStaticPath(webRoot, pathname);
  if (!filePath) {
    res.writeHead(400, SECURITY_HEADERS);
    return res.end('Bad request');
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (!info.isFile()) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': info.size,
    // Short cache with revalidation: changes show up quickly during development.
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
  return undefined;
}
