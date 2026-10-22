// The budget: 100k rows × 20 columns per side compared in about two seconds on a
// laptop. The limits here are generous for slow CI machines; the timings are printed so
// the real numbers can be read off a run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
/** A deterministic "word" for a cell, so both tables agree row for row. */
const word = (r, k) => ((Math.imul(r + 1, 2654435761) ^ Math.imul(k + 1, 40503)) >>> 0).toString(36);

/** `cardinality`: how many distinct values the text-ish columns take (low → no column is unique). */
function table(rows, cols, mutate, cardinality = Infinity) {
  const header = ['id', ...Array.from({ length: cols - 1 }, (_, i) => `col_${i}`)].join(',');
  const lines = [header];
  for (let r = 0; r < rows; r++) {
    const cells = [String(r + 1)];
    const rr = r % cardinality;
    for (let k = 1; k < cols; k++) cells.push(k % 3 === 0 ? String((rr * 7919 + k) % 10007) : k % 3 === 1 ? `"${word(rr, k)} ${k}"` : `v${(rr + k) % 97}`);
    lines.push(mutate ? mutate(r, cells).join(',') : cells.join(','));
  }
  return lines.join('\n') + '\n';
}

describe('performance', () => {
  it('100k rows × 20 columns, keyed', () => {
    const t0 = performance.now();
    const a = table(100_000, 20);
    const b = table(100_000, 20, (r, cells) => {
      if (r % 1000 === 0) cells[5] = 'changed';
      return cells;
    });
    const made = performance.now();
    const L = c.parseTable(a);
    const R = c.parseTable(b);
    const parsed = performance.now();
    const d = c.diffTables(L, R);
    const diffed = performance.now();
    const s = new c.Session();
    s.tables = { left: L, right: R };
    s.result = d;
    s.window(50_000, 50_200);
    s.search({ text: 'changed', caseSensitive: false, regex: false, column: -1 });
    const queried = performance.now();
    console.log(`  perf keyed: ${((a.length + b.length) / 1e6).toFixed(1)} MB of text; parse ${Math.round(parsed - made)} ms, diff ${Math.round(diffed - parsed)} ms, window+search ${Math.round(queried - diffed)} ms (generate ${Math.round(made - t0)} ms)`);
    assert.equal(d.summary.changed, 100);
    assert.equal(d.summary.unchanged, 99_900);
    assert.deepEqual(d.keyCols, [0]);
    assert.ok(diffed - made < 8000, `parse+diff took ${Math.round(diffed - made)} ms`);
  });

  it('100k rows × 20 columns, no key (content alignment)', () => {
    const t0 = performance.now();
    // Every column repeats (1000 distinct values), so neither a column nor a pair of columns is a key.
    const noId = (r, cells) => {
      cells[0] = `g${r % 1000}`;
      return cells;
    };
    const a = table(100_000, 20, noId, 1000);
    const b = table(
      100_000,
      20,
      (r, cells) => {
        noId(r, cells);
        if (r % 5000 === 0) cells[4] = 'changed';
        return cells;
      },
      1000,
    );
    const made = performance.now();
    const d = c.diffTables(c.parseTable(a), c.parseTable(b), { keyColumns: [] });
    const diffed = performance.now();
    console.log(`  perf content: parse+diff ${Math.round(diffed - made)} ms (generate ${Math.round(made - t0)} ms)`);
    assert.equal(d.keyMode, 'none');
    assert.equal(d.summary.changed, 20);
    assert.ok(diffed - made < 12000, `took ${Math.round(diffed - made)} ms`);
  });

  it('shuffled rows: every row moved, still fast', () => {
    const a = table(50_000, 10);
    const lines = a.split('\n');
    const head = lines.shift();
    lines.pop();
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    const t0 = performance.now();
    const d = c.diffTables(c.parseTable(a), c.parseTable(head + '\n' + lines.join('\n') + '\n'));
    const t1 = performance.now();
    console.log(`  perf shuffled: ${Math.round(t1 - t0)} ms, ${d.summary.moved} moved`);
    assert.equal(d.summary.changed + d.summary.added + d.summary.removed, 0);
    assert.ok(d.summary.moved > 40_000);
    assert.equal(c.diffTables(c.parseTable(a), c.parseTable(head + '\n' + lines.join('\n') + '\n'), { ignoreRowOrder: true }).summary.moved, 0);
  });
});
