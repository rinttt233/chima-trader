// Build-time shim injected into the portable bundle.
// Provides the handful of Node 14+/18 APIs the app uses but Node 12 lacks.
import iconv from 'iconv-lite';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { TextDecoder as NativeTextDecoder } from 'util';

// ---- TextDecoder (GBK + UTF-8) ----
const NativeDecoder = NativeTextDecoder;
class TextDecoderShim {
  constructor(label = 'utf-8', options = {}) {
    this.label = String(label).toLowerCase();
    this.options = options || {};
  }
  decode(buffer) {
    if (this.label === 'gbk' || this.label === 'gb2312' || this.label === 'gb18030') {
      return iconv.decode(Buffer.from(buffer || []), 'gbk');
    }
    return new NativeDecoder('utf-8', this.options).decode(buffer);
  }
}
if (typeof globalThis.TextDecoder === 'undefined' || !supportsGbk()) {
  globalThis.TextDecoder = TextDecoderShim;
}
function supportsGbk() {
  try {
    new globalThis.TextDecoder('gbk').decode(Buffer.from([0xb9, 0xc9]));
    return true;
  } catch {
    return false;
  }
}

// ---- AbortController ----
class AbortSignalShim {
  constructor() {
    this.aborted = false;
    this.reason = undefined;
    this._listeners = [];
  }
  addEventListener(type, fn) {
    if (type === 'abort') this._listeners.push(fn);
  }
  removeEventListener(type, fn) {
    if (type !== 'abort') return;
    this._listeners = this._listeners.filter((item) => item !== fn);
  }
  _raise(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const fn of this._listeners) {
      try { fn({ type: 'abort', target: this }); } catch { /* ignore */ }
    }
  }
}
if (typeof globalThis.AbortController === 'undefined') {
  globalThis.AbortController = class AbortController {
    constructor() { this.signal = new AbortSignalShim(); }
    abort(reason) { this.signal._raise(reason); }
  };
}

// ---- fetch (GET/HEAD, redirects, abort) ----
function requestOnce(target, options, signal) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target); } catch (err) { reject(err); return; }
    const lib = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!lib) { reject(new Error(`不支持的协议：${url.protocol}`)); return; }
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeoutMs || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) { req.destroy(signal.reason || new Error('aborted')); return; }
      signal.addEventListener('abort', () => req.destroy(signal.reason || new Error('aborted')));
    }
    req.end();
  });
}

if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = async function fetchShim(input, init = {}) {
    const options = init || {};
    let target = String(input && input.url ? input.url : input);
    let method = String(options.method || 'GET').toUpperCase();
    let headers = options.headers || {};
    let result = null;
    for (let hop = 0; hop < 6; hop += 1) {
      result = await requestOnce(target, { method, headers, timeoutMs: options.timeoutMs }, options.signal);
      const location = result.headers && result.headers.location;
      if (result.status >= 300 && result.status < 400 && location) {
        target = new URL(location, target).toString();
        if (result.status === 303 || (result.status !== 307 && result.status !== 308 && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
        }
        continue;
      }
      break;
    }
    const rawHeaders = result.headers || {};
    const headerPairs = [];
    for (const key of Object.keys(rawHeaders)) {
      const value = rawHeaders[key];
      headerPairs.push([key, Array.isArray(value) ? value.join(', ') : String(value)]);
    }
    const ok = result.status >= 200 && result.status < 300;
    return {
      status: result.status,
      ok,
      statusText: '',
      url: target,
      headers: { entries: () => headerPairs[Symbol.iterator]() },
      arrayBuffer: async () => result.buffer.buffer.slice(result.buffer.byteOffset, result.buffer.byteOffset + result.buffer.byteLength),
      text: async () => result.buffer.toString('utf8'),
      json: async () => JSON.parse(result.buffer.toString('utf8')),
    };
  };
}

// ---- fs.rmSync (Node 14+) ----
if (typeof fs.rmSync !== 'function') {
  fs.rmSync = function rmSync(target, options = {}) {
    let stat = null;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isDirectory()) {
      fs.rmdirSync(target, { recursive: true });
    } else {
      fs.unlinkSync(target);
    }
  };
}
