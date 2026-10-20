// Thin client for the Shop n Delight API. Every failure becomes an ApiError with a
// stable code, so views can show a useful message instead of a raw exception.

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// Render services may need extra time to wake after inactivity; avoid failing the first request too early.
const DEFAULT_TIMEOUT_MS = 30000;

async function send(method, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError('bad_response', 'We received an unexpected response. Please try again.', res.status);
      }
    }

    if (!res.ok) {
      const code = json?.error?.code ?? 'http_error';
      const message = json?.error?.message ?? `Request failed (${res.status}).`;
      throw new ApiError(code, message, res.status);
    }
    return json;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') {
      throw new ApiError('timeout', 'That took too long. Check your connection and try again.');
    }
    throw new ApiError('network', 'We can’t reach Shop n Delight right now. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

// GET requests get one automatic retry, since they are safe to repeat.
// Writes never retry automatically, so an add-to-cart cannot be applied twice.
export async function get(path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    return await send('GET', path, undefined, timeoutMs);
  } catch (err) {
    if (err.code !== 'network' && err.code !== 'timeout') throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return send('GET', path, undefined, timeoutMs);
  }
}

export function post(path, body) {
  return send('POST', path, body, DEFAULT_TIMEOUT_MS);
}

export function patch(path, body) {
  return send('PATCH', path, body, DEFAULT_TIMEOUT_MS);
}

export function put(path, body) {
  return send('PUT', path, body, DEFAULT_TIMEOUT_MS);
}

export function del(path) {
  return send('DELETE', path, undefined, DEFAULT_TIMEOUT_MS);
}
