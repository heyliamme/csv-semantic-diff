// How two cells are compared. Whitespace, case and number spelling can be ignored, so
// `1.0` equals `1` and `1e3` equals `1000`, while `007` stays text (a code, not a number).

export interface NormalizeOptions {
  /** Compare numbers by value. */
  normalizeNumbers: boolean;
  /** `1,000` and `1 000` are the number 1000. */
  thousandsSeparators: boolean;
  trimWhitespace: boolean;
  ignoreCase: boolean;
  /** `1,5` is the number 1.5 (`;` files, from decimal-comma locales). */
  decimalComma?: boolean;
}

export const DEFAULT_NORMALIZE: NormalizeOptions = { normalizeNumbers: true, thousandsSeparators: false, trimWhitespace: true, ignoreCase: false };

/** A number without leading zeros (`007` is text), optionally signed, decimal or exponent. */
const NUMBER = /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DECIMAL_COMMA = /^[+-]?(?:0|[1-9]\d*),\d+$/;
const GROUPED = /^[+-]?\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function isNumeric(s: string): boolean {
  return NUMBER.test(s);
}

/**
 * Canonical spelling of a number: sign, significant digits and exponent, exact for any
 * length. `1`, `1.0000000000000000` and `10e-1` all read `1e0`; there is one form for
 * every value, so padding never matters, and nothing is rounded through a double (no
 * collapse of `1e400` to Infinity or of 64-bit ids to the nearest float).
 */
export function canonNumber(s: string): string {
  return exactCanon(s);
}

/** `-001.500e3` → `-15e2`: sign, significant digits, exponent. Exact for any length. */
export function exactCanon(raw: string): string {
  let s = raw;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  let expText = '';
  const e = s.search(/[eE]/);
  if (e >= 0) {
    expText = s.slice(e + 1).replace(/^\+/, '');
    s = s.slice(0, e);
  }
  const dot = s.indexOf('.');
  let digits = s;
  let shift = 0;
  if (dot >= 0) {
    digits = s.slice(0, dot) + s.slice(dot + 1);
    shift = s.length - dot - 1;
  }
  let from = 0;
  while (from < digits.length && digits.charCodeAt(from) === 48) from++;
  let to = digits.length;
  while (to > from && digits.charCodeAt(to - 1) === 48) to--;
  if (from === to) return '0';
  const adjust = digits.length - to - shift;
  digits = digits.slice(from, to);
  // Exponents that fit a double exactly are added as numbers; longer ones as BigInt.
  const exp = expText.length < 15 ? String((expText ? Number(expText) : 0) + adjust) : String(BigInt(expText) + BigInt(adjust));
  return (neg ? '-' : '') + digits + 'e' + exp;
}

/** The form of a cell that is compared and hashed. */
export function normalizeCell(s: string, o: NormalizeOptions): string {
  let v = o.trimWhitespace ? s.trim() : s;
  // Line ends inside a quoted cell are not content: CRLF and LF read the same.
  if (v.indexOf('\r') >= 0) v = v.replace(/\r\n?/g, '\n');
  if (o.normalizeNumbers && v.length) {
    const c = v.charCodeAt(0);
    // Cheap gate: numbers start with a digit, a sign or a point.
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      if (NUMBER.test(v)) return canonNumber(v);
      if (o.thousandsSeparators && GROUPED.test(v)) return canonNumber(v.replace(/[, ]/g, ''));
      if (o.decimalComma && !o.thousandsSeparators && DECIMAL_COMMA.test(v)) return canonNumber(v.replace(',', '.'));
    }
  }
  if (o.ignoreCase) v = v.toLowerCase();
  return v;
}

/** The same, but a missing cell (short row) and an empty one both read as "". */
export function normalizeOrEmpty(s: string | undefined, o: NormalizeOptions): string {
  return s === undefined ? '' : normalizeCell(s, o);
}

/** A key pattern such as `*_ts` or `updated_at`, matched against a column name. */
export function nameMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => false;
  if (!p.includes('*') && !p.includes('?')) {
    const low = p.toLowerCase();
    return (name) => name.toLowerCase() === low;
  }
  const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return (name) => re.test(name);
}
