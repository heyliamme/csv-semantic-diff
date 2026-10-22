// Pairs the columns of two tables: by name first (exact, then ignoring case), and the
// leftovers by content, so a renamed column reads as a rename instead of a removal
// and an addition.
import { mergeOrder } from './align';
import { normalizeOrEmpty, type NormalizeOptions } from './normalize';
import type { Table } from './parse';

export type ColumnStatus = 'eq' | 'add' | 'del' | 'ren';

export interface Column {
  /** The name shown: the right side's for a renamed column. */
  name: string;
  /** Index in each table, -1 when the side doesn't have it. */
  li: number;
  ri: number;
  st: ColumnStatus;
  /** The left side's name, when renamed. */
  from?: string;
  key?: boolean;
  ignored?: boolean;
}

const RENAME_SIMILARITY = 0.5;
const SAMPLE = 50_000;

/** A column's non-empty values with how often each occurs, over every row. */
export interface ValueCounts {
  counts: Map<string, number>;
  filled: number;
}

/**
 * The values of a column, all of them up to SAMPLE rows; beyond that the ones whose hash
 * falls in one bucket of `buckets`, so both sides keep the same values whatever their
 * row order or length.
 */
export function valueCounts(t: Table, i: number, o: NormalizeOptions, buckets = 1): ValueCounts {
  const counts = new Map<string, number>();
  let filled = 0;
  for (const row of t.rows) {
    const v = normalizeOrEmpty(row[i], o);
    if (v === '') continue;
    if (buckets > 1 && hash(v) % buckets !== 0) continue;
    filled++;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return { counts, filled };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return h >>> 0;
}

/**
 * Shared values (with repeats) over the smaller side, so a table that grew or was
 * reordered still matches; but over the larger side when the shared part is only a
 * sliver of it, so a handful of values can't claim a big column.
 */
function similarity(a: ValueCounts, b: ValueCounts): number {
  const [small, big] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [v, n] of small.counts) shared += Math.min(n, big.counts.get(v) ?? 0);
  const min = Math.min(a.filled, b.filled);
  const max = Math.max(a.filled, b.filled);
  if (!min) return 0;
  return shared * 4 >= max ? shared / min : shared / max;
}

const bucketsFor = (L: Table, R: Table) => Math.max(1, Math.ceil(Math.max(L.rows.length, R.rows.length) / SAMPLE));

/** How alike two columns' contents are: shared non-empty values over the smaller side, wherever the rows are. */
export function contentSimilarity(L: Table, li: number, R: Table, ri: number, o: NormalizeOptions): number {
  const b = bucketsFor(L, R);
  return similarity(valueCounts(L, li, o, b), valueCounts(R, ri, o, b));
}

/**
 * Whether a column's values say enough about it for a content match: many distinct
 * values (names, ids, amounts), not a small domain (true/false, a status, a country)
 * that any two unrelated columns can share.
 */
export function diverse(t: Table, i: number, o: NormalizeOptions): boolean {
  const seen = new Set<string>();
  let filled = 0;
  const limit = Math.min(SAMPLE, t.rows.length);
  for (let r = 0; r < limit; r++) {
    const v = normalizeOrEmpty(t.rows[r][i], o);
    if (v === '') continue;
    filled++;
    seen.add(v);
  }
  return filled > 0 && seen.size >= Math.min(3, filled) && seen.size * 2 >= filled;
}

/** A name's words: `full_name`, `fullName` and `Full Name` are all ["full", "name"]. */
function words(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * `full_name` and `Name`, `active` and `is_active`: one name's words are all in the
 * other. Whole words, so `inactive` is not `active` and `unpaid` is not `paid`.
 */
export function relatedNames(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  const [small, big] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  if (small.every((w) => big.has(w))) return true;
  // `isActive` written as one word: `isactive`, `hasaddress`.
  const glue = (p: string[], q: string[]) => ['is', 'has'].some((pre) => p.join('') === pre + q.join(''));
  return glue(x, y) || glue(y, x);
}

export function matchColumns(L: Table, R: Table, o: NormalizeOptions): Column[] {
  const exact = new Map<string, number[]>();
  const loose = new Map<string, number[]>();
  R.columns.forEach((name, j) => {
    (exact.get(name) ?? exact.set(name, []).get(name)!).push(j);
    const low = name.toLowerCase();
    (loose.get(low) ?? loose.set(low, []).get(low)!).push(j);
  });
  const taken = new Set<number>();
  const byLeft = new Map<number, Column>();
  const byRight = new Map<number, Column>();
  const pair = (li: number, ri: number, st: ColumnStatus, from?: string) => {
    const c: Column = { name: R.columns[ri], li, ri, st };
    if (from !== undefined) c.from = from;
    byLeft.set(li, c);
    byRight.set(ri, c);
    taken.add(ri);
  };
  // Exact names first, so `Name` pairs with `Name` even when `name` is also there.
  L.columns.forEach((name, i) => {
    const js = exact.get(name);
    const j = js?.find((x) => !taken.has(x));
    if (j !== undefined) pair(i, j, 'eq');
  });
  L.columns.forEach((name, i) => {
    if (byLeft.has(i)) return;
    const js = loose.get(name.toLowerCase());
    const j = js?.find((x) => !taken.has(x));
    if (j !== undefined) pair(i, j, 'eq');
  });
  // Leftovers: a column whose values reappear under another name was renamed. Values
  // from a small domain only count when the names are related too.
  const dels = L.columns.map((_, i) => i).filter((i) => !byLeft.has(i));
  const adds = R.columns.map((_, j) => j).filter((j) => !taken.has(j));
  if (dels.length && adds.length && dels.length * adds.length <= 400) {
    const cands: [number, number, number, number][] = []; // score, distance, li, ri
    const leftDiverse = new Map(dels.map((li) => [li, diverse(L, li, o)]));
    const rightDiverse = new Map(adds.map((ri) => [ri, diverse(R, ri, o)]));
    const b = bucketsFor(L, R);
    const lv = new Map<number, ValueCounts>();
    const rv = new Map<number, ValueCounts>();
    const values = (m: Map<number, ValueCounts>, t: Table, i: number) => m.get(i) ?? m.set(i, valueCounts(t, i, o, b)).get(i)!;
    for (const li of dels)
      for (const ri of adds) {
        if (!(leftDiverse.get(li) && rightDiverse.get(ri)) && !relatedNames(L.columns[li], R.columns[ri])) continue;
        const s = similarity(values(lv, L, li), values(rv, R, ri));
        if (s >= RENAME_SIMILARITY) cands.push([s, Math.abs(li - ri), li, ri]);
      }
    cands.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    for (const [, , li, ri] of cands) if (!byLeft.has(li) && !taken.has(ri)) pair(li, ri, 'ren', L.columns[li]);
  }
  const leftSeq = L.columns.map((name, i) => byLeft.get(i) ?? ({ name, li: i, ri: -1, st: 'del' } as Column));
  const rightSeq = R.columns.map((name, j) => byRight.get(j) ?? ({ name, li: -1, ri: j, st: 'add' } as Column));
  for (const c of rightSeq) if (c.st === 'add') byRight.set(c.ri, c);
  return mergeOrder(leftSeq, R.columns.map((_, j) => byRight.get(j)!));
}

/** Whether the shared columns come in a different order on the right. */
export function columnsReordered(columns: Column[]): boolean {
  const shared = columns.filter((c) => c.li >= 0 && c.ri >= 0);
  for (let k = 1; k < shared.length; k++) if (shared[k].ri < shared[k - 1].ri) return true;
  return false;
}
