// Sequence helpers shared by the row and column matching: a fast string hash, a merge
// of two orders, longest increasing subsequence, and a longest common subsequence that
// is exact when small and patience/Myers otherwise.

export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Left order, with right-only entries slotted in after their nearest right-hand
 * predecessor and after any left-only entries that follow it, so a removal reads before
 * the addition that replaces it.
 */
export function mergeOrder<T>(left: readonly T[], right: readonly T[]): T[] {
  const inLeft = new Set(left);
  const inRight = new Set(right);
  const head: T[] = [];
  const after = new Map<T, T[]>();
  let prev: T | undefined;
  let seen = false;
  for (const x of right) {
    if (inLeft.has(x)) {
      prev = x;
      seen = true;
    } else if (!seen) head.push(x);
    else {
      let list = after.get(prev as T);
      if (!list) after.set(prev as T, (list = []));
      list.push(x);
    }
  }
  const out: T[] = [];
  let pending = head;
  for (const x of left) {
    if (inRight.has(x) && pending.length) {
      for (const p of pending) out.push(p);
      pending = [];
    }
    out.push(x);
    const list = after.get(x);
    if (list) pending = pending.length ? pending.concat(list) : list;
  }
  for (const p of pending) out.push(p);
  return out;
}

/** Indices (into seq) of one longest strictly increasing subsequence. */
export function lisIndices(seq: ArrayLike<number>): Set<number> {
  const tails: number[] = [];
  const prev = new Int32Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(k);
  return keep;
}

/**
 * Matching positions of a shortest edit script between a[a0..a1) and b[b0..b1)
 * (Myers 1986), or undefined if it needs more than maxEdits edits.
 */
export function myers(a: ArrayLike<number>, b: ArrayLike<number>, a0: number, a1: number, b0: number, b1: number, maxEdits: number): [number, number][] | undefined {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const out: [number, number][] = [];
        let cx = n;
        let cy = m;
        for (let e = d; e >= 0; e--) {
          const row = trace[e];
          const at = (kk: number) => row[kk + e + 1];
          const ck = cx - cy;
          const pk = ck === -e || (ck !== e && at(ck - 1) < at(ck + 1)) ? ck + 1 : ck - 1;
          const px = e === 0 ? 0 : at(pk);
          const py = px - pk;
          while (cx > px && cy > py && cx > 0 && cy > 0) out.push([a0 + --cx, b0 + --cy]);
          cx = px;
          cy = py;
        }
        return out.reverse();
      }
    }
  }
  return undefined;
}

const LCS_LIMIT = 4_000_000;
const MYERS_MAX_EDITS = 2000;

/**
 * Matching positions of a longest common subsequence of hl[a0..a1) and hr[b0..b1).
 * Exact (dynamic programming) when the area is small; otherwise patience diff: anchor
 * on items that occur once on each side, then recurse between the anchors.
 */
export function common(hl: ArrayLike<number>, hr: ArrayLike<number>, a0: number, a1: number, b0: number, b1: number, out: [number, number][] = []): [number, number][] {
  while (a0 < a1 && b0 < b1 && hl[a0] === hr[b0]) out.push([a0++, b0++]);
  const tail: [number, number][] = [];
  while (a0 < a1 && b0 < b1 && hl[a1 - 1] === hr[b1 - 1]) tail.push([--a1, --b1]);
  const n = a1 - a0;
  const m = b1 - b0;
  if (n > 0 && m > 0 && n * m <= LCS_LIMIT) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = hl[a0 + i] === hr[b0 + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (hl[a0 + i] === hr[b0 + j]) out.push([a0 + i++, b0 + j++]);
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  } else if (n > 0 && m > 0) {
    const count = new Map<number, [number, number, number]>(); // hash -> [left count, right count, left index]
    for (let i = a0; i < a1; i++) {
      const c = count.get(hl[i]);
      if (c) c[0]++;
      else count.set(hl[i], [1, 0, i]);
    }
    for (let j = b0; j < b1; j++) {
      const c = count.get(hr[j]);
      if (c) c[1]++;
    }
    const unique: [number, number][] = [];
    for (let j = b0; j < b1; j++) {
      const c = count.get(hr[j]);
      if (c && c[0] === 1 && c[1] === 1) unique.push([c[2], j]);
    }
    unique.sort((x, y) => x[0] - y[0]);
    const keep = lisIndices(unique.map((u) => u[1]));
    const anchors = unique.filter((_, k) => keep.has(k));
    let pi = a0;
    let pj = b0;
    for (const [ai, aj] of anchors) {
      common(hl, hr, pi, ai, pj, aj, out);
      out.push([ai, aj]);
      pi = ai + 1;
      pj = aj + 1;
    }
    if (anchors.length) common(hl, hr, pi, a1, pj, b1, out);
    else for (const p of myers(hl, hr, a0, a1, b0, b1, MYERS_MAX_EDITS) ?? []) out.push(p);
  }
  for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
  return out;
}
