// The grid's HTML: every piece of document text is escaped, the cells line up with the
// columns in both views, and search matches are marked without breaking the escaping.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');
const r = require('../dist/render.js');

function setup(a, b, opts = {}) {
  const s = new c.Session();
  s.load('left', { text: a });
  s.load('right', { text: b });
  const result = s.compare(opts, { left: true, right: true });
  const columns = result.columns;
  const ctx = {
    rows: result,
    columns,
    visibleCols: columns.map((_, k) => k),
    view: 'unified',
    leftCols: columns.map((x, k) => ({ x, k })).filter(({ x }) => x.li >= 0).sort((p, q) => p.x.li - q.x.li).map(({ k }) => k),
    rightCols: columns.map((x, k) => ({ x, k })).filter(({ x }) => x.ri >= 0).sort((p, q) => p.x.ri - q.x.ri).map(({ k }) => k),
    lines: { left: s.lines('left'), right: s.lines('right') },
  };
  return { s, result, ctx, win: s.window(0, 1000) };
}

const text = (html) => html.replace(/<[^>]+>/g, '');
const cells = (html) => [...html.matchAll(/<div class="cell[^"]*"[^>]*>(.*?)<\/div>/g)].map((m) => m[1]);

describe('render', () => {
  it('escapes HTML in cells, headers, titles and aria labels', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { ctx, win } = setup(`id,"${evil}"\n1,"a&b"\n`, `id,"${evil}"\n1,"<b>x</b>"\n`);
    const head = r.headHtml(ctx);
    assert.ok(!head.includes('<img'), head);
    assert.ok(head.includes('&lt;img src=x onerror=alert(1)&gt;'));
    const row = r.rowHtml(ctx, 0, 0, win, false);
    assert.ok(!row.includes('<img') && !row.includes('<b>'), row);
    assert.ok(row.includes('a&amp;b'));
    assert.ok(row.includes('&lt;b&gt;x&lt;/b&gt;'));
    // The title attribute holds the raw old → new, escaped.
    assert.ok(/title="a&amp;b → &lt;b&gt;x&lt;\/b&gt;"/.test(row), row);
  });

  it('unified rows: gutters, status, one cell per visible column, old → new in changed cells', () => {
    const { ctx, win, result } = setup('id,v,w\n1,a,x\n2,b,y\n', 'id,v,z\n2,B,7\n3,c,8\n');
    assert.equal(result.n, 3);
    const rows = Array.from({ length: 3 }, (_, i) => r.rowHtml(ctx, i, i, win, i === 1));
    // Row 0: id 1 removed.
    assert.ok(rows[0].includes('class="row del"'));
    assert.deepEqual(cells(rows[0]).slice(0, 3), ['2', '', '<span aria-hidden="true">−</span>']);
    assert.equal(cells(rows[0]).length, 3 + ctx.columns.length);
    // Row 1: id 2 changed in v; selected.
    assert.ok(rows[1].includes('class="row chg sel"'));
    assert.ok(rows[1].includes('<span class="old">b</span><span class="arr" aria-hidden="true">→</span><span class="new">B</span>'));
    assert.ok(rows[1].includes('aria-selected="true"'));
    // Row 2: id 3 added, with the line number on the right only.
    assert.ok(rows[2].includes('class="row add"'));
    assert.deepEqual(cells(rows[2]).slice(0, 2), ['', '3']);
    // Removed and added columns shade their cells.
    assert.ok(rows[1].includes('class="cell none cdel"') || rows[1].includes('cdel'));
    assert.ok(rows[1].includes('cadd'));
  });

  it('side-by-side rows: each side in its own column order, fillers for one-sided rows', () => {
    const { ctx, win } = setup('id,v,w\n1,a,x\n2,b,y\n', 'w,id,v\ny,2,B\nq,3,c\n');
    ctx.view = 'sideBySide';
    const head = r.headHtml(ctx);
    const names = [...head.matchAll(/<span class="hn">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(names, ['id', 'v', 'w', 'w', 'id', 'v']);
    const row0 = r.rowHtml(ctx, 0, 0, win, false); // removed: right side is filler
    assert.equal((row0.match(/class="cell fill"/g) || []).length, 3);
    const row2 = r.rowHtml(ctx, 2, 2, win, false); // added: left side is filler
    assert.equal((row2.match(/class="cell fill"/g) || []).length, 3);
    const row1 = r.rowHtml(ctx, 1, 1, win, false);
    assert.ok(row1.includes('class="cell cl"') && row1.includes('class="cell cr"'), row1);
  });

  it('placeholders when the window is not loaded', () => {
    const { ctx } = setup('id,v\n1,a\n', 'id,v\n1,b\n');
    const row = r.rowHtml(ctx, 0, 0, undefined, false);
    assert.ok(row.includes('loading'));
    assert.equal((row.match(/class="cell ph/g) || []).length, 2);
  });

  it('marks search matches inside escaped text', () => {
    const { s, ctx } = setup('id,v\n1,"<a&b>"\n', 'id,v\n1,"<a&b>"\n');
    const found = s.search({ text: 'A&B', caseSensitive: false, regex: false, column: -1 });
    ctx.hits = new Set(found.rows);
    ctx.sid = found.sid;
    const row = r.rowHtml(ctx, 0, 0, s.window(0, 1000), false);
    assert.ok(row.includes('&lt;<mark>a&amp;b</mark>&gt;'), row);
    assert.ok(row.includes('class="row eq hit"'));
    // Marks from an older search are not shown.
    ctx.sid = found.sid - 1;
    assert.ok(!r.rowHtml(ctx, 0, 0, s.window(0, 1000), false).includes('<mark>'));
  });

  it('marks only the searched column and never runs the pattern in the view', () => {
    const evil = 'a'.repeat(30) + '!';
    const { s, ctx } = setup(`id,note\nX1,${evil}\n`, `id,note\nX1,${evil}\n`);
    const found = s.search({ text: '^X', caseSensitive: true, regex: true, column: 0 });
    assert.deepEqual(found.rows, [0]);
    ctx.hits = new Set(found.rows);
    ctx.sid = found.sid;
    const t0 = Date.now();
    const row = r.rowHtml(ctx, 0, 0, s.window(0, 1000), false);
    assert.ok(Date.now() - t0 < 200);
    assert.equal((row.match(/<mark>/g) || []).length, 1);
    assert.ok(row.includes('<mark>X</mark>1'));
  });

  it('shows line breaks and tabs in cells as symbols', () => {
    assert.equal(r.cellText('a\r\nb\tc'), 'a↵b→c');
    assert.equal(r.cellText(null), '');
  });

  it('header badges: key, renamed, added, removed, ignored', () => {
    const { ctx } = setup('id,full_name,x\n1,Ann,p\n2,Bo,q\n', 'id,name,y\n1,Ann,7\n2,Bo,8\n', { ignoreColumns: ['y'] });
    const head = r.headHtml(ctx);
    assert.ok(head.includes('codicon-key'));
    assert.ok(head.includes('>was full_name<'));
    assert.ok(head.includes('>removed<') && head.includes('>added<') && head.includes('>ignored<'));
  });

  it('column tracks and widths', () => {
    const { ctx, win } = setup('id,description\n1,a rather long description here\n', 'id,description\n1,short\n');
    const w = r.measure(ctx.columns, win, new Set([1]));
    assert.equal(w.length, 2);
    assert.ok(w[1] > w[0]);
    assert.ok(r.tracks(ctx, w).startsWith('var(--lnw) var(--lnw) 2.2ch '));
    ctx.view = 'sideBySide';
    assert.ok(r.tracks(ctx, w).includes(' var(--lnw) '));
  });

  it('says what happened to a row and its cells, for screen readers', () => {
    const { ctx, win } = setup('id,v\n1,a\n2,b\n', 'id,v\n2,B\n3,c\n');
    const del = r.rowHtml(ctx, 0, 0, win, false);
    assert.ok(del.includes('aria-label="removed row"') && del.includes('aria-label="v: a, removed row"'), del);
    ctx.view = 'sideBySide';
    const chg = r.rowHtml(ctx, 1, 1, win, false);
    assert.ok(chg.includes('aria-label="v: b, changed to B"') && chg.includes('aria-label="v: B, changed from b"'), chg);
    assert.ok(!r.rowHtml(ctx, 2, 2, win, false).includes('aria-label="unchanged row"'));
  });

  it('a window can hold only some columns (very wide tables)', () => {
    const { s } = setup('id,a,b,c\n1,x,y,z\n', 'id,a,b,c\n1,x,y,q\n');
    const w = s.window(0, 10, [0, 3]);
    assert.deepEqual(w.cols, [0, 3]);
    assert.deepEqual(w.l[0], ['1', 'z']);
    assert.deepEqual(w.r[0], ['1', 'q']);
  });
});
