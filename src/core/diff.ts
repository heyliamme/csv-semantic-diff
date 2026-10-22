// The comparison: columns paired by name or content, rows paired by key (or aligned by
// content when there is no key), moves found with a longest increasing subsequence,
// and cells compared under the normalisation options.
import { common, cyrb53, lisIndices, mergeOrder } from './align';
import { columnsReordered, matchColumns, type Column } from './columns';
import { chooseKey, keyOf, keyOptions, type KeyMode } from './keys';
import { DEFAULT_NORMALIZE, nameMatcher, normalizeCell, type NormalizeOptions } from './normalize';
import type { Table } from './parse';

export interface DiffOptions extends NormalizeOptions {
  /** Preferred key column names, tried in order; `a+b` is a composite key. */
  keyColumns: string[];
  /** Key columns chosen by hand for this comparison (overrides everything). */
  keys?: string[];
  /** Key columns from the per-file setting. */
  fileKeys?: string[];
  /** Columns whose differences are shown but not counted (names, `*` wildcard). */
  ignoreColumns: string[];
  /** An empty cell equals a missing one. */
  emptyEqualsMissing: boolean;
  /** Rows that only changed place are not reported. */
  ignoreRowOrder: boolean;
}

export const DEFAULT_OPTIONS: DiffOptions = {
  ...DEFAULT_NORMALIZE,
  keyColumns: ['id', 'ID', '_id', 'uuid', 'key', 'code', 'sku', 'email', 'name'],
  ignoreColumns: [],
  emptyEqualsMissing: true,
  ignoreRowOrder: false,
};

/** Row status. */
export const EQ = 0;
export const CHG = 1;
export const ADD = 2;
export const DEL = 3;
export const MV = 4;
/** Moved and changed. */
export const MVCHG = 5;

export interface Summary {
  added: number;
  removed: number;
  changed: number;
  moved: number;
  unchanged: number;
  /** Distinct columns with at least one changed cell. */
  changedColumns: number;
  /** Cell differences in ignored columns. */
  ignored: number;
  columnsAdded: number;
  columnsRemoved: number;
  columnsRenamed: number;
  columnsReordered: boolean;
  duplicates: { left: number; right: number };
}

export interface DiffResult {
  columns: Column[];
  /** Output column indices of the key. */
  keyCols: number[];
  keyMode: KeyMode;
  /** Number of rows in the comparison. */
  n: number;
  /** Per row: status, left row index (-1 when absent), right row index. */
  st: Uint8Array;
  li: Int32Array;
  ri: Int32Array;
  /** Per row: output columns whose cells differ, or 0. */
  chg: (number[] | 0)[];
  /** Per row: differing cells in ignored columns, or 0. */
  ign: (number[] | 0)[];
  summary: Summary;
  warnings: string[];
  notes: string[];
}

interface Pair {
  li?: number;
  ri?: number;
  moved?: boolean;
}

/** Over PAIR_LIMIT, a removed row is compared with added rows this close in position. */
const PAIR_WINDOW = 64;
const PAIR_LIMIT = 250_000;
/** A removed and an added row pair up as one edited row when at least half of it (weighted) is the same. */
const MIN_SIMILARITY = 0.5;

export function diffTables(L: Table, R: Table, options: Partial<DiffOptions> = {}): DiffResult {
  const o: DiffOptions = { ...DEFAULT_OPTIONS, ...options };
  // `;` files come from locales that write 1,5 for 1.5. Tab files do not say which
  // locale wrote them, and most are English, where `1,500` is grouped thousands.
  const commaLocale = (t: Table) => t.delimiter === ';';
  if (o.decimalComma === undefined) o.decimalComma = commaLocale(L) && commaLocale(R);
  const columns = matchColumns(L, R, o);
  const matchers = o.ignoreColumns.map(nameMatcher);
  for (const c of columns) if (matchers.some((m) => m(c.name) || (c.from !== undefined && m(c.from)))) c.ignored = true;
  const key = chooseKey(L, R, columns, o, { explicit: o.keys, file: o.fileKeys, setting: o.keyColumns });
  for (const k of key.cols) columns[k].key = true;
  const warnings = [...L.warnings.map((w) => `Left: ${w}`), ...R.warnings.map((w) => `Right: ${w}`)];
  const notes: string[] = [];
  if (key.duplicates.left || key.duplicates.right) {
    const parts = [key.duplicates.left && `${key.duplicates.left} on the left`, key.duplicates.right && `${key.duplicates.right} on the right`].filter(Boolean);
    warnings.push(`The key is not unique (${parts.join(', ')}); repeated keys are matched in order of appearance.`);
  }

  const pairs = key.cols.length ? byKey(L, R, columns, key.cols, o) : byContent(L, R, columns, o);
  if (!key.cols.length && (L.rows.length || R.rows.length)) notes.push(key.mode === 'explicit' ? 'Rows aligned by content, as chosen (no key)' : 'No key column found: rows are aligned by content');

  const n = pairs.length;
  const st = new Uint8Array(n);
  const li = new Int32Array(n);
  const ri = new Int32Array(n);
  const chg: (number[] | 0)[] = new Array(n);
  const ign: (number[] | 0)[] = new Array(n);
  const summary: Summary = {
    added: 0,
    removed: 0,
    changed: 0,
    moved: 0,
    unchanged: 0,
    changedColumns: 0,
    ignored: 0,
    columnsAdded: columns.filter((c) => c.st === 'add').length,
    columnsRemoved: columns.filter((c) => c.st === 'del').length,
    columnsRenamed: columns.filter((c) => c.st === 'ren').length,
    columnsReordered: columnsReordered(columns),
    duplicates: key.duplicates,
  };
  const shared = columns.map((c, k) => (c.li >= 0 && c.ri >= 0 ? k : -1)).filter((k) => k >= 0);
  const changedCols = new Set<number>();
  const eqCell = (a: string | undefined, b: string | undefined): boolean => {
    if (a === b) return true;
    if (a === undefined || b === undefined) {
      const other = a === undefined ? b! : a!;
      return o.emptyEqualsMissing && (o.trimWhitespace ? other.trim() : other) === '';
    }
    return normalizeCell(a, o) === normalizeCell(b, o);
  };
  for (let i = 0; i < n; i++) {
    const p = pairs[i];
    li[i] = p.li ?? -1;
    ri[i] = p.ri ?? -1;
    chg[i] = 0;
    ign[i] = 0;
    if (p.li === undefined) {
      st[i] = ADD;
      summary.added++;
      continue;
    }
    if (p.ri === undefined) {
      st[i] = DEL;
      summary.removed++;
      continue;
    }
    const a = L.rows[p.li];
    const b = R.rows[p.ri];
    let diffs: number[] | 0 = 0;
    let ignored: number[] | 0 = 0;
    for (const k of shared) {
      const c = columns[k];
      if (eqCell(a[c.li], b[c.ri])) continue;
      if (c.ignored) (ignored || (ignored = [])).push(k);
      else {
        (diffs || (diffs = [])).push(k);
        changedCols.add(k);
      }
    }
    chg[i] = diffs;
    ign[i] = ignored;
    if (ignored) summary.ignored += ignored.length;
    const moved = !!p.moved && !o.ignoreRowOrder;
    if (diffs) {
      st[i] = moved ? MVCHG : CHG;
      summary.changed++;
      if (moved) summary.moved++;
    } else if (moved) {
      st[i] = MV;
      summary.moved++;
    } else {
      st[i] = EQ;
      summary.unchanged++;
    }
  }
  summary.changedColumns = changedCols.size;
  return { columns, keyCols: key.cols, keyMode: key.mode, n, st, li, ri, chg, ign, summary, warnings, notes };
}

// --- rows paired by key -------------------------------------------------------------------

function byKey(L: Table, R: Table, columns: Column[], keyCols: number[], options: NormalizeOptions): Pair[] {
  const o = keyOptions(options);
  const lc = keyCols.map((k) => columns[k].li);
  const rc = keyCols.map((k) => columns[k].ri);
  // Repeated keys pair up in order of appearance: the second "x" on the left with the second on the right.
  const leftAt = new Map<string, number[]>();
  L.rows.forEach((row, i) => {
    const k = keyOf(row, lc, o);
    const list = leftAt.get(k);
    if (list) list.push(i);
    else leftAt.set(k, [i]);
  });
  const byLeft = new Map<number, Pair>();
  const byRight = new Map<number, Pair>();
  const used = new Map<string, number>();
  R.rows.forEach((row, j) => {
    const k = keyOf(row, rc, o);
    const list = leftAt.get(k);
    if (!list) return;
    const nth = used.get(k) ?? 0;
    used.set(k, nth + 1);
    const i = list[nth];
    if (i === undefined) return;
    const p = { li: i, ri: j };
    byLeft.set(i, p);
    byRight.set(j, p);
  });
  const leftSeq = L.rows.map((_, i) => byLeft.get(i) ?? { li: i });
  markMoves(leftSeq);
  return mergeOrder(
    leftSeq,
    R.rows.map((_, j) => byRight.get(j) ?? { ri: j }),
  );
}

/** Matched rows that fall outside the longest run in the same order are the ones that moved. */
function markMoves(leftSeq: Pair[]) {
  const matched = leftSeq.filter((p) => p.li !== undefined && p.ri !== undefined);
  // Backwards, so ties keep the earlier rows in place and flag the later ones.
  const seq = new Int32Array(matched.length);
  for (let i = 0; i < matched.length; i++) seq[i] = -matched[matched.length - 1 - i].ri!;
  const back = lisIndices(seq);
  const keep = new Set<number>();
  for (const i of back) keep.add(matched.length - 1 - i);
  matched.forEach((p, i) => {
    if (!keep.has(i)) p.moved = true;
  });
}

// --- rows aligned by content (no key) ------------------------------------------------

function rowHashes(t: Table, cols: number[], o: NormalizeOptions): Float64Array {
  const h = new Float64Array(t.rows.length);
  for (let i = 0; i < t.rows.length; i++) {
    const row = t.rows[i];
    let s = '';
    for (const c of cols) {
      const v = row[c];
      s += (v === undefined ? '' : normalizeCell(v, o)) + '\u001f';
    }
    h[i] = cyrb53(s);
  }
  return h;
}

function byContent(L: Table, R: Table, columns: Column[], o: DiffOptions): Pair[] {
  const shared = columns.filter((c) => c.li >= 0 && c.ri >= 0 && !c.ignored);
  // No column in common: there is nothing to compare rows by, so none of them match.
  if (!shared.length) return [...L.rows.map((_, li) => ({ li })), ...R.rows.map((_, ri) => ({ ri }))];
  const hl = rowHashes(L, shared.map((c) => c.li), o);
  const hr = rowHashes(R, shared.map((c) => c.ri), o);
  const nl = L.rows.length;
  const nr = R.rows.length;
  const kept: Pair[] = [];
  const gaps: { dels: number[]; adds: number[] }[] = [];
  let i = 0;
  let j = 0;
  const gapUntil = (li: number, ri: number) => {
    const g = { dels: [] as number[], adds: [] as number[] };
    while (i < li) g.dels.push(i++);
    while (j < ri) g.adds.push(j++);
    if (g.dels.length || g.adds.length) gaps.push(g);
  };
  for (const [li, ri] of common(hl, hr, 0, nl, 0, nr)) {
    gapUntil(li, ri);
    kept.push({ li: i++, ri: j++ });
  }
  gapUntil(nl, nr);

  // A row removed in one place and added unchanged in another moved.
  const free = new Map<number, number[]>();
  for (const g of gaps) for (const ri of g.adds) (free.get(hr[ri]) ?? free.set(hr[ri], []).get(hr[ri])!).push(ri);
  const movedTo = new Map<number, number>();
  const takenRight = new Set<number>();
  for (const g of gaps)
    for (const li of g.dels) {
      const ri = free.get(hl[li])?.shift();
      if (ri === undefined) continue;
      movedTo.set(li, ri);
      takenRight.add(ri);
    }
  const pairs: Pair[] = [...kept];
  for (const [li, ri] of movedTo) pairs.push({ li, ri, moved: true });
  const singles: Pair[] = [];
  const sim = similarity(L, R, shared);
  for (const g of gaps)
    for (const p of pairUp(g.dels.filter((li) => !movedTo.has(li)), g.adds.filter((ri) => !takenRight.has(ri)), sim, true))
      (p.li !== undefined && p.ri !== undefined ? pairs : singles).push(p);
  // A row that moved to another gap and changed on the way.
  const far = pairUp(
    singles.filter((p) => p.ri === undefined).map((p) => p.li!),
    singles.filter((p) => p.li === undefined).map((p) => p.ri!),
    sim,
    false,
    0.6,
  );
  for (const p of far) pairs.push(p);
  const matched = pairs.filter((p) => p.li !== undefined && p.ri !== undefined).sort((a, b) => a.li! - b.li!);
  for (const p of matched) p.moved = false;
  markMoves(matched);
  const byLeft = new Map<number, Pair>();
  const byRight = new Map<number, Pair>();
  for (const p of pairs) {
    if (p.li !== undefined) byLeft.set(p.li, p);
    if (p.ri !== undefined) byRight.set(p.ri, p);
  }
  return mergeOrder(
    L.rows.map((_, li) => byLeft.get(li)!),
    R.rows.map((_, ri) => byRight.get(ri)!),
  );
}

/**
 * How alike two rows are, 0..1. An equal cell counts by how telling its column is: a
 * column with many distinct values (names, amounts) counts in full, one that most rows
 * share (a status, a country) counts little, so two unrelated rows with the same
 * boilerplate don't pair up.
 */
function similarity(L: Table, R: Table, shared: Column[]) {
  const weight = shared.map((c) => {
    const seen = new Set<string>();
    const sample = Math.min(L.rows.length, 5000);
    for (let r = 0; r < sample; r++) seen.add(L.rows[r][c.li] ?? '');
    return Math.min(1, Math.max(0.1, seen.size / Math.max(1, sample)));
  });
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const o = DEFAULT_NORMALIZE;
  return (li: number, ri: number): number => {
    const a = L.rows[li];
    const b = R.rows[ri];
    let s = 0;
    for (let k = 0; k < shared.length; k++) {
      const x = a[shared[k].li] ?? '';
      const y = b[shared[k].ri] ?? '';
      if (x === y || normalizeCell(x, o) === normalizeCell(y, o)) s += weight[k];
    }
    return s / total;
  };
}

/** Turns a run of removed and added rows into modifications where that reads better. */
function pairUp(dels: number[], adds: number[], sim: (li: number, ri: number) => number, ordered: boolean, minSimilarity = MIN_SIMILARITY): Pair[] {
  const pairOf = new Map<number, Pair>();
  const usedRight = new Set<number>();
  if (!dels.length || !adds.length) return [...dels.map((li) => ({ li })), ...adds.map((ri) => ({ ri }))];
  const cands: [number, number, number, number][] = []; // score, distance, li, ri
  const consider = (k: number, q: number) => {
    const sc = sim(dels[k], adds[q]);
    if (sc >= minSimilarity) cands.push([sc, Math.abs(q - (k * adds.length) / Math.max(1, dels.length)), dels[k], adds[q]]);
  };
  if (dels.length * adds.length > PAIR_LIMIT) {
    for (let k = 0; k < dels.length; k++) {
      const centre = Math.round((k * adds.length) / Math.max(1, dels.length));
      for (let q = Math.max(0, centre - PAIR_WINDOW); q < Math.min(adds.length, centre + PAIR_WINDOW); q++) consider(k, q);
    }
  } else for (let k = 0; k < dels.length; k++) for (let q = 0; q < adds.length; q++) consider(k, q);
  cands.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (const [, , li, ri] of cands) {
    if (pairOf.has(li) || usedRight.has(ri)) continue;
    usedRight.add(ri);
    pairOf.set(li, { li, ri });
  }
  if (ordered) {
    // Pairs must not cross, or the right column would no longer read in its own order.
    const sorted = [...pairOf.values()].sort((a, b) => a.li! - b.li!);
    const keep = lisIndices(sorted.map((p) => p.ri!));
    sorted.forEach((p, i) => {
      if (!keep.has(i)) pairOf.delete(p.li!);
    });
  }
  const byRight = new Map<number, Pair>();
  for (const p of pairOf.values()) byRight.set(p.ri!, p);
  return mergeOrder(
    dels.map((li) => pairOf.get(li) ?? { li }),
    adds.map((ri) => byRight.get(ri) ?? { ri }),
  );
}

/** "3 added, 1 removed, 12 changed in 4 columns, 2 moved, 1 column renamed". */
export function summaryText(s: Summary): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (s.added) parts.push(`${s.added} added`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.changed) parts.push(`${s.changed} changed in ${plural(s.changedColumns, 'column')}`);
  if (s.moved) parts.push(`${s.moved} moved`);
  if (s.columnsAdded) parts.push(`${plural(s.columnsAdded, 'column')} added`);
  if (s.columnsRemoved) parts.push(`${plural(s.columnsRemoved, 'column')} removed`);
  if (s.columnsRenamed) parts.push(`${plural(s.columnsRenamed, 'column')} renamed`);
  if (!parts.length) return s.ignored ? `no differences counted (${s.ignored} ignored)` : 'no differences';
  return parts.join(', ') + (s.ignored ? ` (${s.ignored} ignored)` : '');
}
