// TextDecoder shim for the embedded nodejs-mobile runtime.
//
// nodejs-mobile is configured with `--with-intl=none`, so Node's WHATWG
// TextDecoder only knows the UTF encodings it implements in JS: asking for
// `TextDecoder('gbk')` throws ERR_ENCODING_NOT_SUPPORTED. The Tencent / Sina
// quote endpoints answer in GBK, so `lib/net.mjs` needs a working GBK decoder.
//
// esbuild injects this module (see build-node-assets.mjs), replacing every free
// `TextDecoder` identifier in the bundle. Native decoding is preferred whenever
// the host Node can do it (desktop runs keep byte-identical behaviour); GBK is
// decoded with iconv-lite when the runtime cannot.
import iconv from 'iconv-lite';

const NativeTextDecoder = typeof globalThis.TextDecoder === 'function' ? globalThis.TextDecoder : null;
const FORCE_SHIM = process.env.CHIMA_FORCE_ENCODING_SHIM === '1';

const GBK_ALIASES = new Set([
  'gbk',
  'gb2312',
  'x-gbk',
  'cp936',
  'windows-936',
  'ms936',
  'csgb2312',
  'gb_2312',
  'gb_2312-80',
  'chinese',
  'iso-ir-58',
]);

const GB18030_ALIASES = new Set(['gb18030', 'gb-18030', 'gb_18030']);

function normalizeLabel(label) {
  return String(label === undefined || label === null ? 'utf-8' : label).trim().toLowerCase();
}

function nativeCanDecode(label) {
  if (!NativeTextDecoder) return false;
  try {
    new NativeTextDecoder(label); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

function toBuffer(input) {
  if (input === undefined || input === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(String(input), 'utf8');
}

class TextDecoder {
  constructor(label, options) {
    const opts = options || {};
    this.__label = normalizeLabel(label);
    this.fatal = Boolean(opts.fatal);
    this.ignoreBOM = Boolean(opts.ignoreBOM);
    this.__impl = null;
    this.__iconvEncoding = null;

    if (!FORCE_SHIM && nativeCanDecode(this.__label)) {
      try {
        this.__impl = new NativeTextDecoder(this.__label, opts);
      } catch {
        this.__impl = null;
      }
    }

    if (this.__impl) {
      this.encoding = this.__impl.encoding;
      return;
    }
    if (GBK_ALIASES.has(this.__label)) {
      this.__iconvEncoding = 'gbk';
      this.encoding = 'gbk';
    } else if (GB18030_ALIASES.has(this.__label)) {
      this.__iconvEncoding = 'gb18030';
      this.encoding = 'gb18030';
    } else if (this.__label === 'utf-8' || this.__label === 'utf8') {
      // Should always be handled natively; decode manually as a last resort.
      this.__iconvEncoding = 'utf8';
      this.encoding = 'utf-8';
    } else {
      throw new RangeError(`TextDecoder: unsupported encoding "${label}" on this runtime`);
    }
  }

  decode(input, options) {
    if (this.__impl) return this.__impl.decode(input, options);
    const buffer = toBuffer(input);
    if (this.fatal && this.__iconvEncoding === 'utf8') {
      return new NativeTextDecoder('utf-8', options).decode(buffer);
    }
    return iconv.decode(buffer, this.__iconvEncoding || 'gbk');
  }
}

// Keep parity with the platform class for feature detection code.
if (NativeTextDecoder && typeof NativeTextDecoder.prototype.decode === 'function') {
  TextDecoder.prototype.constructor = TextDecoder;
}

export { TextDecoder };
