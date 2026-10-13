// A deliberately small HTTP router built on node:http, so the server has no
// third-party runtime dependencies. It supports exact paths, :param segments,
// JSON bodies with a size limit, and cookies. It is not a general framework.

import { CartError } from './cart.js';

const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function compile(path) {
  const names = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), names };
}

export function createRouter() {
  const routes = [];

  function add(method, path, handler) {
    const { regex, names } = compile(path);
    routes.push({ method, path, regex, names, handler });
  }

  return {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    patch: (path, handler) => add('PATCH', path, handler),
    put: (path, handler) => add('PUT', path, handler),
    delete: (path, handler) => add('DELETE', path, handler),

    match(method, pathname) {
      let pathMatched = false;
      for (const route of routes) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = {};
        route.names.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1]);
        });
        return { handler: route.handler, params };
      }
      return { handler: null, params: {}, pathMatched };
    },
  };
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        return reject(new HttpError(413, 'body_too_large', 'Request body is too large.'));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'bad_request', 'Request body must be a JSON object.'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'bad_request', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

// Maps any thrown error to a JSON response. Known errors keep their message;
// everything else is logged server-side and returned as a generic message.
export function sendError(res, err) {
  if (err instanceof CartError || err instanceof HttpError) {
    return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  }
  console.error(err);
  return sendJson(res, 500, {
    error: { code: 'server_error', message: 'Something went wrong. Please try again.' },
  });
}
