// Which column (or columns) identify a row. Preferred names from the settings are tried
// first; failing that, any column that is unique and never empty on both sides, then
// pairs of columns. A candidate also has to share values across the sides, or it would
// match nothing.
import type { Column } from './columns';
import { normalizeOrEmpty, type NormalizeOptions } from './normalize';
import type { Table } from './parse';

export type KeyMode = 'explicit' | 'file' | 'setting' | 'auto' | 'none';

export interface KeyChoice {
  /** Output column indices. */
  cols: number[];
  mode: KeyMode;
  /** Set when the chosen key has repeated values on a side. */
  duplicates: { left: number; right: number };
}

/** `a+b` → ["a", "b"]; a plain name is a one-column key. */
export function splitKeySpec(spec: string): string[] {
  return spec
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

const KEY_SEP = '\u001f';

/**
 * How key values are compared: trimmed and case-folded as the cells are, but never as
 * numbers, so identifiers such as `1.1` and `1.10` or `1e3` and `1000` stay distinct.
 */
export function keyOptions(o: NormalizeOptions): NormalizeOptions {
  return { normalizeNumbers: false, thousandsSeparators: false, trimWhitespace: o.trimWhitespace, ignoreCase: o.ignoreCase };
}

export function keyOf(row: string[], cols: number[], o: NormalizeOptions): string {
  if (cols.length === 1) return normalizeOrEmpty(row[cols[0]], o);
  let k = '';
  for (let i = 0; i < cols.length; i++) k += (i ? KEY_SEP : '') + normalizeOrEmpty(row[cols[i]], o);
  return k;
}

interface ColumnStat {
  unique: boolean;
  nonEmpty: boolean;
  values: Set<string>;
}

/**
 * Uniqueness and emptiness of one key (one or more table columns) on one side. Without
 * `needValues` it stops at the first repeated or empty value, which is what makes
 * trying every column cheap: a status column fails on its second row.
 */
function stat(t: Table, cols: number[], o: NormalizeOptions, needValues: boolean): ColumnStat {
  const values = new Set<string>();
  let unique = true;
  let nonEmpty = true;
  const single = cols.length === 1 ? cols[0] : -1;
  for (const row of t.rows) {
    let k: string;
    if (single >= 0) {
      k = normalizeOrEmpty(row[single], o);
      if (k === '') nonEmpty = false;
    } else {
      k = '';
      for (let i = 0; i < cols.length; i++) {
        const v = normalizeOrEmpty(row[cols[i]], o);
        if (v === '') nonEmpty = false;
        k += (i ? KEY_SEP : '') + v;
      }
    }
    if (!nonEmpty && !needValues) break;
    if (values.has(k)) {
      unique = false;
      if (!needValues) break;
    } else values.add(k);
  }
  return { unique, nonEmpty, values };
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) n++;
  return n;
}

/** Name → output column index, matched ignoring case, for columns present on both sides and not ignored. */
export function findColumn(columns: Column[], name: string): number {
  const low = name.trim().toLowerCase();
  const ok = (c: Column) => c.li >= 0 && c.ri >= 0 && !c.ignored;
  let k = columns.findIndex((c) => ok(c) && c.name === name.trim());
  if (k < 0) k = columns.findIndex((c) => ok(c) && c.name.toLowerCase() === low);
  if (k < 0) k = columns.findIndex((c) => ok(c) && c.from?.toLowerCase() === low);
  return k;
}

/**
 * Whether a column just numbers the rows (0..n-1 or 1..n, top to bottom): a pandas index,
 * `#`, a rank. Pairing rows by it pairs them by position, so an insert or a sort would
 * read as every row changed.
 */
function rowNumbers(t: Table, col: number): boolean {
  if (!t.rows.length) return false;
  const first = (t.rows[0][col] ?? '').trim();
  if (first !== '0' && first !== '1') return false;
  const start = Number(first);
  for (let i = 0; i < t.rows.length; i++) if ((t.rows[i][col] ?? '').trim() !== String(start + i)) return false;
  return true;
}

export function chooseKey(L: Table, R: Table, columns: Column[], options: NormalizeOptions, prefs: { explicit?: string[]; file?: string[]; setting: string[] }): KeyChoice {
  const o = keyOptions(options);
  const none: KeyChoice = { cols: [], mode: 'none', duplicates: { left: 0, right: 0 } };
  if (!L.rows.length && !R.rows.length) return none;
  // An empty explicit choice means "no key: align rows by content".
  if (prefs.explicit && !prefs.explicit.length) return { ...none, mode: 'explicit' };
  const usable = columns.map((c, k) => (c.li >= 0 && c.ri >= 0 && !c.ignored ? k : -1)).filter((k) => k >= 0);
  if (!usable.length) return none;

  const tableCols = (ks: number[], side: 'li' | 'ri') => ks.map((k) => columns[k][side]);
  const dupCount = (t: Table, cols: number[]) => {
    const seen = new Set<string>();
    let d = 0;
    for (const row of t.rows) {
      const k = keyOf(row, cols, o);
      if (seen.has(k)) d++;
      else seen.add(k);
    }
    return d;
  };
  // Chosen by hand or for this file name: used as is, with a warning about duplicates.
  for (const [names, mode] of [
    [prefs.explicit, 'explicit'],
    [prefs.file, 'file'],
  ] as const) {
    if (!names?.length) continue;
    const cols = names.map((n) => findColumn(columns, n));
    if (cols.some((k) => k < 0)) continue;
    return { cols, mode, duplicates: { left: dupCount(L, tableCols(cols, 'li')), right: dupCount(R, tableCols(cols, 'ri')) } };
  }

  // Candidates are scored one at a time and their value sets dropped straight after, so
  // a wide table without an obvious key never holds every column's values at once.
  /** The share of values the sides have in common, or -1 when `cols` can't be a key. */
  const evaluate = (cols: number[]): number => {
    const lc = tableCols(cols, 'li');
    const rc = tableCols(cols, 'ri');
    // Cheap early exits on the first repeat or empty value, on both sides.
    const ql = stat(L, lc, o, false);
    if (!ql.unique || !ql.nonEmpty) return -1;
    const qr = stat(R, rc, o, false);
    if (!qr.unique || !qr.nonEmpty) return -1;
    if (!L.rows.length || !R.rows.length) return 0;
    const l = stat(L, lc, o, true);
    const r = stat(R, rc, o, true);
    const shared = overlap(l.values, r.values);
    if (!shared) return -1;
    return shared / Math.max(1, l.values.size, r.values.size);
  };

  // Preferred names, in the order given.
  for (const spec of prefs.setting) {
    const cols = splitKeySpec(spec).map((n) => findColumn(columns, n));
    if (!cols.length || cols.some((k) => k < 0)) continue;
    if (evaluate(cols) >= 0) return { cols, mode: 'setting', duplicates: { left: 0, right: 0 } };
  }
  // Any one column; the one sharing the most values wins, ties to the leftmost (so a
  // column sharing every value ends the search). Row numbers on both sides are not keys.
  const candidates = usable.filter((k) => !(rowNumbers(L, columns[k].li) && rowNumbers(R, columns[k].ri)));
  let best: { cols: number[]; s: number } | undefined;
  for (const k of candidates) {
    const s = evaluate([k]);
    if (s < 0) continue;
    if (!best || s > best.s) best = { cols: [k], s };
    if (s >= 1) break;
  }
  if (best) return { cols: best.cols, mode: 'auto', duplicates: { left: 0, right: 0 } };
  // Pairs of the first columns (combinations of many columns are expensive and rarely keys).
  const few = candidates.slice(0, 10);
  for (let a = 0; a < few.length; a++)
    for (let b = a + 1; b < few.length; b++) {
      const cols = [few[a], few[b]];
      const s = evaluate(cols);
      if (s < 0) continue;
      if (!best || s > best.s) best = { cols, s };
    }
  if (best) return { cols: best.cols, mode: 'auto', duplicates: { left: 0, right: 0 } };
  return none;
}
