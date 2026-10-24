// lib/net.mjs — transport layer for the paper trading platform.
//
// Responsibilities:
//   * direct HTTPS requests with a hard timeout (Node's global fetch)
//   * HTTPS-over-HTTP-CONNECT tunnel through the local proxy from config.json
//   * smart routing: Tencent domains go direct, foreign hosts go through the proxy,
//     with automatic fallback to the other mode and a 10 minute per-host memory
//   * TTL cache + in-flight request de-duplication (one request for concurrent callers)
//   * GBK / JSON decoding helpers
//   * per-host health bookkeeping so the health endpoint can explain failures
//
// Only Node standard library is used.

import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../config.json', import.meta.url);

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
  } catch {
    return {};
  }
}

const config = loadConfig();

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MODE_TTL_MS = 10 * 60 * 1000;
const PROXY_FAILURE_COOLDOWN_MS = 30 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const proxyConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 65532,
  hosts: [],
  ...(config.proxy || {}),
};

// Hosts that are known to be reachable directly from mainland China.
const DIRECT_HOST_PATTERNS = [
  /(^|\.)gtimg\.cn$/i,
  /(^|\.)qq\.com$/i,
  /(^|\.)sina\.com\.cn$/i,
  /(^|\.)sinajs\.cn$/i,
  // Binance's public market-data mirror works without the local proxy.
  /(^|\.)binance\.vision$/i,
];

// ---------------------------------------------------------------------------
// Cache & host state
// ---------------------------------------------------------------------------

/** @type {Map<string, { value: object, expires: number }>} */
const responseCache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();
/** @type {Map<string, { mode: 'direct' | 'proxy', expires: number }>} */
const modeCache = new Map();
/** @type {Map<string, { host: string, mode: string, ok: boolean, latencyMs: number, message: string, at: number }>} */
const hostStates = new Map();

// Circuit breaker: when the local proxy refuses connections we fail proxy-routed
// hosts fast instead of waiting for direct-route timeouts on every 2s quote poll.
let proxyFailureUntil = 0;

/** True while the proxy circuit breaker is open. */
export function proxyFailureActive() {
  return proxyFailureUntil > Date.now();
}

/** Open the proxy circuit breaker (e.g. after an explicit TCP probe failed). */
export function markProxyUnreachable() {
  proxyFailureUntil = Date.now() + PROXY_FAILURE_COOLDOWN_MS;
}

/** Close the proxy circuit breaker (e.g. after the proxy came back). */
export function resetProxyBreaker() {
  proxyFailureUntil = 0;
}

function noteProxyOutcome(mode, error) {
  if (mode !== 'proxy') return;
  if (!error) {
    proxyFailureUntil = 0;
    return;
  }
  const message = String(error.message || '');
  if (/代理连接失败|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EACCES|代理隧道握手失败/.test(message)) {
    proxyFailureUntil = Date.now() + PROXY_FAILURE_COOLDOWN_MS;
  }
}

function cacheGet(key) {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  if (!(ttlMs > 0)) return;
  responseCache.set(key, { value, expires: Date.now() + ttlMs });
  if (responseCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (v.expires <= now) responseCache.delete(k);
    }
    while (responseCache.size > 400) {
      const oldest = responseCache.keys().next().value;
      responseCache.delete(oldest);
    }
  }
}

function recordHostState(host, { mode, ok, latencyMs, message }) {
  hostStates.set(host, { host, mode, ok, latencyMs, message, at: new Date().toISOString() });
}

/** Last known outcome per host (used for sync market metadata / diagnostics). */
export function getHostStates() {
  return [...hostStates.values()].map((s) => ({ ...s }));
}

/** Last known outcome for one host, or null when the host was never contacted. */
export function getHostState(host) {
  const s = hostStates.get(host);
  return s ? { ...s } : null;
}

/** Clear every cache (used by tests). */
export function _resetCacheForTest() {
  responseCache.clear();
  inflight.clear();
  modeCache.clear();
  hostStates.clear();
  proxyFailureUntil = 0;
}

// ---------------------------------------------------------------------------
// Proxy configuration
// ---------------------------------------------------------------------------

/** Runtime override of the proxy settings (mainly for tests). */
export function configureProxy(next = {}) {
  Object.assign(proxyConfig, next);
  modeCache.clear();
}

export function proxyInfo() {
  return {
    enabled: Boolean(proxyConfig.enabled),
    host: proxyConfig.host,
    port: Number(proxyConfig.port),
    hosts: [...(proxyConfig.hosts || [])],
  };
}

/** Cheap TCP probe of the local proxy port; resolves to a Chinese-readable verdict. */
export function probeProxy(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!proxyConfig.enabled) {
      resolve({ ok: false, message: '代理未启用（config.json proxy.enabled=false），境外行情源不可用' });
      return;
    }
    const address = `${proxyConfig.host}:${proxyConfig.port}`;
    let settled = false;
    const socket = net.connect({ host: proxyConfig.host, port: Number(proxyConfig.port) });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, message: `代理 ${address} 连接超时（可能未启动），境外行情源不可用` }),
      timeoutMs,
    );
    socket.once('connect', () => finish({ ok: true, message: `代理 ${address} 可用` }));
    socket.once('error', (err) =>
      finish({
        ok: false,
        message: `代理 ${address} 不可用（${err.code || err.message}），境外行情源不可用`,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

function isDirectHost(host) {
  return DIRECT_HOST_PATTERNS.some((re) => re.test(host));
}

function preferredMode(host) {
  if (!proxyConfig.enabled) return 'direct';
  const list = proxyConfig.hosts || [];
  if (list.includes(host)) return 'proxy';
  if (isDirectHost(host)) return 'direct';
  return 'proxy';
}

function abortableTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();
  return { controller, clear: () => clearTimeout(timer) };
}

/** Plain fetch with timeout; returns { status, ok, headers, buffer }. */
export async function fetchDirect(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET' } = {}) {
  const { controller, clear } = abortableTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries()),
      buffer,
      via: 'direct',
    };
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || '未知错误';
    throw new Error(`直连失败（${cause}）`);
  } finally {
    clear();
  }
}

function decodeChunked(buffer) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) throw new Error('分块响应不完整');
    const size = parseInt(buffer.subarray(offset, lineEnd).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('分块响应长度非法');
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size > buffer.length) throw new Error('分块响应被截断');
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (buffer.subarray(offset, offset + 2).toString('latin1') === '\r\n') offset += 2;
  }
  return Buffer.concat(chunks);
}

function parseHttpResponse(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new Error('响应头不完整');
  const head = raw.subarray(0, headerEnd).toString('latin1');
  const lines = head.split('\r\n');
  const statusLine = lines[0] || '';
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
  if (!match) throw new Error('响应状态行非法');
  const status = Number(match[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = raw.subarray(headerEnd + 4);
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = decodeChunked(body);
  else if (headers['content-length'] !== undefined) body = body.subarray(0, Number(headers['content-length']));
  return { status, ok: status >= 200 && status < 300, headers, buffer: body, via: 'proxy' };
}

/**
 * HTTPS (or plain HTTP) request tunnelled through the local HTTP proxy using CONNECT.
 * Resolves to { status, ok, headers, buffer, via: 'proxy' }.
 */
export function fetchViaProxy(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    if (!proxyConfig.enabled) {
      reject(new Error('代理未启用'));
      return;
    }
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`请求地址非法：${url}`));
      return;
    }
    const isTls = target.protocol === 'https:';
    const targetHost = target.hostname;
    const targetPort = Number(target.port || (isTls ? 443 : 80));
    const requestPath = `${target.pathname || '/'}${target.search || ''}`;

    let settled = false;
    let rawSocket = null;
    let tlsSocket = null;
    const chunks = [];
    let received = 0;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        tlsSocket?.destroy();
      } catch {
        /* ignore */
      }
      try {
        rawSocket?.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('代理请求超时')), timeoutMs);

    const collect = (chunk) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        finish(new Error('响应体过大'));
        return;
      }
      chunks.push(chunk);
    };

    const complete = () => {
      if (settled) return;
      try {
        const parsed = parseHttpResponse(Buffer.concat(chunks));
        if (parsed.status >= 400) {
          finish(new Error(`HTTP ${parsed.status}`));
          return;
        }
        finish(null, parsed);
      } catch (err) {
        finish(new Error(`代理响应解析失败：${err.message}`));
      }
    };

    const writeRequest = (socket) => {
      const lines = [
        `${method} ${requestPath} HTTP/1.1`,
        `Host: ${target.host}`,
        `User-Agent: ${USER_AGENT}`,
        'Accept: */*',
        'Accept-Encoding: identity',
        'Connection: close',
      ];
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && value !== null) lines.push(`${key}: ${value}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    };

    rawSocket = net.connect({ host: proxyConfig.host, port: Number(proxyConfig.port) });
    rawSocket.setNoDelay(true);
    rawSocket.once('error', (err) =>
      finish(new Error(`代理连接失败（${err.code || err.message}）`)),
    );
    rawSocket.once('connect', () => {
      rawSocket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    let handshakeBuffer = Buffer.alloc(0);
    const onHandshakeData = (chunk) => {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const end = handshakeBuffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (handshakeBuffer.length > 64 * 1024) finish(new Error('代理握手响应过大'));
        return;
      }
      const head = handshakeBuffer.subarray(0, end).toString('latin1');
      const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head);
      const status = Number(statusMatch?.[1] || 0);
      if (status !== 200) {
        finish(new Error(`代理隧道握手失败（HTTP ${status || '未知'}）`));
        return;
      }
      rawSocket.removeListener('data', onHandshakeData);
      const leftover = handshakeBuffer.subarray(end + 4);
      handshakeBuffer = Buffer.alloc(0);

      if (isTls) {
        tlsSocket = tls.connect({ socket: rawSocket, servername: targetHost });
        tlsSocket.once('error', (err) =>
          finish(new Error(`TLS 连接失败（${err.code || err.message}）`)),
        );
        tlsSocket.on('data', collect);
        tlsSocket.once('end', complete);
        tlsSocket.once('close', complete);
        tlsSocket.once('secureConnect', () => {
          if (leftover.length) collect(leftover);
          writeRequest(tlsSocket);
        });
      } else {
        rawSocket.on('data', collect);
        rawSocket.once('end', complete);
        rawSocket.once('close', complete);
        if (leftover.length) collect(leftover);
        writeRequest(rawSocket);
      }
    };
    rawSocket.on('data', onHandshakeData);
  });
}

// ---------------------------------------------------------------------------
// Smart request + cache
// ---------------------------------------------------------------------------

function shouldRetryStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * Fetch a URL using direct/proxy routing with one fallback switch (2 retries by
 * default). Response buffers are cached per URL when ttlMs > 0, and concurrent
 * calls for the same URL share a single in-flight request.
 */
export async function request(
  url,
  { host, ttlMs = 0, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', retries = 2 } = {},
) {
  if (ttlMs > 0) {
    const hit = cacheGet(url);
    if (hit) return hit;
  }
  const existing = inflight.get(url);
  if (existing) return existing;

  const targetHost = host || new URL(url).hostname;
  const task = (async () => {
    // Fast failure while the proxy breaker is open: foreign sources are unreachable
    // anyway, and the server polls quotes every 2 seconds.
    if (proxyConfig.enabled && proxyFailureActive() && preferredMode(targetHost) === 'proxy') {
      const message = `境外行情源 ${targetHost} 不可用：本地代理 ${proxyConfig.host}:${proxyConfig.port} 无法连接`;
      recordHostState(targetHost, { mode: 'proxy', ok: false, latencyMs: 0, message });
      throw new Error(message);
    }
    const remembered = modeCache.get(targetHost);
    const first =
      remembered && remembered.expires > Date.now() ? remembered.mode : preferredMode(targetHost);
    const second = first === 'proxy' ? 'direct' : 'proxy';
    const sequence = [];
    for (let i = 0; i <= Math.max(0, retries); i += 1) {
      sequence.push(i % 2 === 0 ? first : second);
    }
    let modes = sequence;
    if (!proxyConfig.enabled) modes = modes.filter((mode) => mode !== 'proxy');
    modes = modes.filter((mode, index) => index === 0 || mode !== modes[index - 1]);
    if (modes.length === 0) modes = ['direct'];

    let lastError = null;
    const startedAt = Date.now();
    for (let index = 0; index < modes.length; index += 1) {
      const mode = modes[index];
      const attemptStart = Date.now();
      try {
        const res =
          mode === 'proxy'
            ? await fetchViaProxy(url, { timeoutMs, headers, method })
            : await fetchDirect(url, { timeoutMs, headers, method });
        if (res.status >= 400 && shouldRetryStatus(res.status)) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (res.status >= 400) {
          const fatal = new Error(`HTTP ${res.status}`);
          recordHostState(targetHost, {
            mode,
            ok: false,
            latencyMs: Date.now() - startedAt,
            message: fatal.message,
          });
          throw fatal;
        }
        modeCache.set(targetHost, { mode, expires: Date.now() + MODE_TTL_MS });
        noteProxyOutcome(mode, null);
        recordHostState(targetHost, {
          mode,
          ok: true,
          latencyMs: Date.now() - attemptStart,
          message: `ok (${mode})`,
        });
        cacheSet(url, res, ttlMs);
        return res;
      } catch (err) {
        lastError = err;
        noteProxyOutcome(mode, err);
        // 4xx client errors are not worth retrying through the other route.
        if (/^HTTP 4\d\d$/.test(err.message) && !/^HTTP 429$/.test(err.message)) break;
      }
    }
    const message = `行情源 ${targetHost} 请求失败：${lastError?.message || '原因未知'}`;
    recordHostState(targetHost, {
      mode: modes[modes.length - 1],
      ok: false,
      latencyMs: Date.now() - startedAt,
      message,
    });
    throw new Error(message);
  })();

  inflight.set(url, task);
  task.then(
    () => inflight.delete(url),
    () => inflight.delete(url),
  );
  return task;
}

export function decodeGbk(buffer) {
  return new TextDecoder('gbk').decode(buffer);
}

export function decodeUtf8(buffer) {
  return new TextDecoder('utf-8').decode(buffer);
}

/** GET text with UTF-8 decoding. */
export async function getText(url, options = {}) {
  const res = await request(url, options);
  return decodeUtf8(res.buffer);
}

/** GET text with GBK decoding (Tencent quote/search endpoints). */
export async function getGbkText(url, options = {}) {
  const res = await request(url, options);
  return decodeGbk(res.buffer);
}

/** GET + JSON.parse. */
export async function getJson(url, options = {}) {
  const res = await request(url, options);
  const text = decodeUtf8(res.buffer);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`行情数据解析失败（${new URL(url).hostname} 返回了非 JSON 内容）`);
  }
}
