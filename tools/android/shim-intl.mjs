// Intl shim for the embedded nodejs-mobile runtime.
//
// nodejs-mobile is built with `./configure --with-intl=none`, so `Intl` does not
// exist at all on Android. The server relies on
// `new Intl.DateTimeFormat(locale, { timeZone, ... }).formatToParts(date)` in
// four places (backup stamps, trading-session calendar, bar timestamps and the
// universe clock), so without a shim the app cannot compute market sessions.
//
// This module is injected by esbuild (see build-node-assets.mjs) which rewrites
// every free `Intl` identifier in the bundle to the value exported here.
//
// Strategy: when the host Node really has ICU, its DateTimeFormat is used, but
// only after a two-probe sanity check (January + July, which exercises DST); if
// native formatting is missing, throws, or disagrees with the built-in IANA
// rules, the pure-JS implementation below is used instead. That keeps desktop
// `node main.js` runs behaviourally identical to the phone.

const NATIVE_INTL = typeof globalThis.Intl === 'object' && globalThis.Intl ? globalThis.Intl : null;
const FORCE_SHIM = process.env.CHIMA_FORCE_INTL_SHIM === '1';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// IANA rules (only the zones this app actually asks for; unknown zones fall
// back to UTC instead of throwing, mirroring the app's defensive style).
// ---------------------------------------------------------------------------

const FIXED = {
  utc: 0,
  'etc/utc': 0,
  gmt: 0,
  'etc/gmt': 0,
  zulu: 0,
  'asia/shanghai': 480,
  'asia/chongqing': 480,
  'asia/harbin': 480,
  'asia/hong_kong': 480,
  'asia/macau': 480,
  'asia/taipei': 480,
  'asia/singapore': 480,
  prc: 480,
  'asia/tokyo': 540,
  'asia/seoul': 540,
  'asia/bangkok': 420,
  'asia/jakarta': 420,
  'asia/kolkata': 330,
  'asia/calcutta': 330,
  'asia/dubai': 240,
  'asia/riyadh': 180,
  'europe/moscow': 180,
};

// zone -> [standard offset minutes, daylight offset minutes]
const DST_ZONES = {
  'america/new_york': [-300, -240],
  'america/toronto': [-300, -240],
  'america/chicago': [-360, -300],
  'america/denver': [-420, -360],
  'america/los_angeles': [-480, -420],
  'europe/london': [0, 60],
  'europe/dublin': [0, 60],
  'europe/lisbon': [0, 60],
  'europe/berlin': [60, 120],
  'europe/paris': [60, 120],
  'europe/rome': [60, 120],
  'europe/madrid': [60, 120],
  'europe/amsterdam': [60, 120],
  'europe/zurich': [60, 120],
  'europe/stockholm': [60, 120],
  'europe/warsaw': [60, 120],
};

const warnedZones = new Set();

function zoneKey(timeZone) {
  return String(timeZone || 'UTC').trim().toLowerCase().replace(/\s+/g, '_');
}

/** UTC instant of the n-th `weekday` (0=Sun) of a UTC month. */
function nthWeekdayUtc(year, monthIndex, weekday, n) {
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const day = 1 + ((weekday - firstWeekday + 7) % 7);
  return Date.UTC(year, monthIndex, day + (n - 1) * 7);
}

/** UTC instant of the last `weekday` (0=Sun) of a UTC month. */
function lastWeekdayUtc(year, monthIndex, weekday) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const lastWeekday = new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay();
  const day = lastDay - ((lastWeekday - weekday + 7) % 7);
  return Date.UTC(year, monthIndex, day);
}

/** True while US daylight saving time is in effect (2nd Sun Mar 07:00Z .. 1st Sun Nov 06:00Z). */
function usDstActive(year, utcMs) {
  const start = nthWeekdayUtc(year, 2, 0, 2) + 7 * HOUR;
  const end = nthWeekdayUtc(year, 10, 0, 1) + 6 * HOUR;
  return utcMs >= start && utcMs < end;
}

/** True while EU summer time is in effect (last Sun Mar 01:00Z .. last Sun Oct 01:00Z). */
function euDstActive(year, utcMs) {
  const start = lastWeekdayUtc(year, 2, 0) + 1 * HOUR;
  const end = lastWeekdayUtc(year, 9, 0) + 1 * HOUR;
  return utcMs >= start && utcMs < end;
}

/** Offset of `timeZone` from UTC at `utcMs`, in minutes. */
export function zoneOffsetMinutes(timeZone, utcMs) {
  const key = zoneKey(timeZone);
  if (Object.prototype.hasOwnProperty.call(FIXED, key)) return FIXED[key];
  const dst = DST_ZONES[key];
  if (dst) {
    const year = new Date(utcMs).getUTCFullYear();
    const euRules = key.startsWith('europe/');
    const active = euRules ? euDstActive(year, utcMs) : usDstActive(year, utcMs);
    return active ? dst[1] : dst[0];
  }
  if (!warnedZones.has(key)) {
    warnedZones.add(key);
    console.error(`[intl-shim] unknown time zone "${timeZone}", falling back to UTC`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// DateTimeFormat
// ---------------------------------------------------------------------------

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function twoDigit(value, style) {
  return style === '2-digit' ? pad2(value) : String(value);
}

function hourCycleOf(options) {
  if (options.hourCycle) return options.hourCycle;
  if (options.hour12 === true) return 'h12';
  if (options.hour12 === false) return 'h23';
  return 'h23';
}

function hoursInCycle(hour, cycle) {
  if (cycle === 'h11') return hour % 12;
  if (cycle === 'h12') return hour % 12 === 0 ? 12 : hour % 12;
  if (cycle === 'h24') return hour === 0 ? 24 : hour;
  return hour;
}

function computeParts(formatter, date) {
  const opts = formatter.__options;
  const ms = date.getTime();
  const timeZone = formatter.__timeZone;
  const shifted = new Date(ms + zoneOffsetMinutes(timeZone, ms) * MINUTE);

  const wantsDate = Boolean(opts.year || opts.month || opts.day);
  const wantsTime = Boolean(opts.hour || opts.minute || opts.second);
  const cycle = hourCycleOf(opts);
  const parts = [];
  const push = (type, value) => {
    if (value !== undefined) parts.push({ type, value });
  };

  if (opts.weekday) {
    const style = opts.weekday;
    push('weekday', style === 'long'
      ? WEEKDAY_LONG[shifted.getUTCDay()]
      : style === 'narrow'
        ? WEEKDAY_SHORT[shifted.getUTCDay()][0]
        : WEEKDAY_SHORT[shifted.getUTCDay()]);
  }
  if (opts.year) {
    const year = shifted.getUTCFullYear();
    push('year', opts.year === '2-digit' ? pad2(year % 100) : String(year));
  }
  if (opts.month) {
    const month = shifted.getUTCMonth();
    if (opts.month === 'long') push('month', MONTH_LONG[month]);
    else if (opts.month === 'short') push('month', MONTH_SHORT[month]);
    else push('month', twoDigit(month + 1, opts.month));
  }
  if (opts.day) push('day', twoDigit(shifted.getUTCDate(), opts.day));
  if (wantsDate && wantsTime) push('literal', ' ');
  if (opts.hour) {
    const hour = hoursInCycle(shifted.getUTCHours(), cycle);
    push('hour', twoDigit(hour, opts.hour));
    if (cycle === 'h11' || cycle === 'h12') {
      push('literal', ' ');
      push('dayPeriod', shifted.getUTCHours() < 12 ? 'AM' : 'PM');
    }
  }
  if (opts.minute) push('minute', twoDigit(shifted.getUTCMinutes(), opts.minute));
  if (opts.second) push('second', twoDigit(shifted.getUTCSeconds(), opts.second));
  if (opts.fractionalSecondDigits) {
    const digits = Number(opts.fractionalSecondDigits) || 0;
    push('fractionalSecond', String(shifted.getUTCMilliseconds()).padStart(3, '0').slice(0, digits));
  }

  // Separators, en-CA style: YYYY-MM-DD HH:MM:SS.
  const withLiterals = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i > 0 && part.type !== 'literal') {
      const prev = parts[i - 1];
      if (prev.type !== 'literal') {
        if (part.type === 'minute' || part.type === 'second') withLiterals.push({ type: 'literal', value: ':' });
        else if (part.type === 'day') withLiterals.push({ type: 'literal', value: '-' });
        else if (part.type === 'month' && prev.type === 'year') withLiterals.push({ type: 'literal', value: '-' });
        else if (part.type === 'hour' && (prev.type === 'day' || prev.type === 'year')) withLiterals.push({ type: 'literal', value: ' ' });
      }
    }
    withLiterals.push(part);
  }
  return withLiterals;
}

class ShimDateTimeFormat {
  constructor(locales, options) {
    this.__locales = Array.isArray(locales) ? locales : locales ? [locales] : [];
    this.__options = options ? { ...options } : {};
    this.__timeZone = this.__options.timeZone || 'UTC';
    this.__native = FORCE_SHIM ? null : createNativeFormatter(this.__locales, this.__options);
    this.__polyfill = this.__native ? null : true;
  }

  format(date) {
    if (this.__native) return this.__native.format(date);
    const parts = computeParts(this, toDate(date));
    return parts.map((part) => part.value).join('');
  }

  formatToParts(date) {
    if (this.__native) return this.__native.formatToParts(date);
    return computeParts(this, toDate(date));
  }

  formatRange() {
    throw new RangeError('formatRange is not supported by the Intl shim');
  }

  resolvedOptions() {
    if (this.__native) return this.__native.resolvedOptions();
    return {
      locale: this.__locales[0] || 'en-CA',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: this.__timeZone,
      hourCycle: hourCycleOf(this.__options),
      hour12: hourCycleOf(this.__options) === 'h11' || hourCycleOf(this.__options) === 'h12',
      year: this.__options.year,
      month: this.__options.month,
      day: this.__options.day,
      hour: this.__options.hour,
      minute: this.__options.minute,
      second: this.__options.second,
      weekday: this.__options.weekday,
    };
  }
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return new Date(value === undefined ? Date.now() : value);
}

/**
 * Returns a native formatter only when it is present AND its answers agree with
 * the built-in rules for the requested zone (guards against ICU-less builds that
 * still expose a stub Intl, e.g. small-icu without tz data).
 */
function createNativeFormatter(locales, options) {
  if (!NATIVE_INTL || typeof NATIVE_INTL.DateTimeFormat !== 'function') return null;
  let native;
  try {
    native = new NATIVE_INTL.DateTimeFormat(locales, options);
  } catch {
    return null;
  }
  const timeZone = options.timeZone;
  if (!timeZone) return native;
  const probes = [Date.UTC(2026, 0, 15, 3, 7, 9), Date.UTC(2026, 6, 15, 3, 7, 9)];
  for (const probe of probes) {
    let nativeParts;
    try {
      nativeParts = native.formatToParts(probe);
    } catch {
      return null;
    }
    const nativeMap = {};
    for (const part of nativeParts) {
      if (part.type !== 'literal') nativeMap[part.type] = part.value;
    }
    const ours = {};
    for (const part of computeParts(
      { __options: options, __timeZone: timeZone },
      new Date(probe),
    )) {
      if (part.type !== 'literal') ours[part.type] = part.value;
    }
    for (const field of ['year', 'month', 'day', 'hour', 'minute']) {
      if (ours[field] === undefined) continue;
      if (Number(nativeMap[field]) !== Number(ours[field])) return null;
    }
  }
  return native;
}

function DateTimeFormat(locales, options) {
  return new ShimDateTimeFormat(locales, options);
}
DateTimeFormat.prototype = ShimDateTimeFormat.prototype;
DateTimeFormat.supportedLocalesOf = (locales) => (Array.isArray(locales) ? locales.slice() : []);

// ---------------------------------------------------------------------------
// NumberFormat (the server does not use it today, but keep the object shape so
// that any future call site does not explode on Android).
// ---------------------------------------------------------------------------

class ShimNumberFormat {
  constructor(locales, options) {
    this.__locales = Array.isArray(locales) ? locales : locales ? [locales] : [];
    this.__options = options ? { ...options } : {};
    this.__native = NATIVE_INTL && typeof NATIVE_INTL.NumberFormat === 'function'
      ? new NATIVE_INTL.NumberFormat(this.__locales, this.__options)
      : null;
  }

  format(value) {
    if (this.__native) return this.__native.format(value);
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const opts = this.__options;
    const digits = opts.maximumFractionDigits === undefined ? 3 : Number(opts.maximumFractionDigits);
    const style = opts.style;
    let text = number.toFixed(Math.max(0, Math.min(20, digits)));
    if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
    if (opts.useGrouping !== false) {
      text = text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    if (style === 'percent') return `${text}%`;
    if (style === 'currency') return `${opts.currency || ''} ${text}`.trim();
    return text;
  }

  resolvedOptions() {
    if (this.__native) return this.__native.resolvedOptions();
    return { locale: this.__locales[0] || 'en-US', ...this.__options };
  }
}

function NumberFormat(locales, options) {
  return new ShimNumberFormat(locales, options);
}
NumberFormat.prototype = ShimNumberFormat.prototype;
NumberFormat.supportedLocalesOf = (locales) => (Array.isArray(locales) ? locales.slice() : []);

// ---------------------------------------------------------------------------

const shimIntl = {
  ...(NATIVE_INTL || {}),
  DateTimeFormat,
  NumberFormat,
  getCanonicalLocales: (locales) => (typeof locales === 'string' ? [locales] : Array.isArray(locales) ? locales.slice() : []),
  supportedValuesOf: () => [],
};

// Also expose it globally: some Node internals resolve `Intl` lazily.
if (!globalThis.Intl) {
  try {
    globalThis.Intl = shimIntl;
  } catch {
    /* ignore */
  }
}

export { shimIntl as Intl };
