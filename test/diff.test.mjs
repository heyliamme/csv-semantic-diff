import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');

const D = (a, b, opts) => c.diffTables(c.parseTable(a), c.parseTable(b), opts);
const WORD = ['eq', 'chg', 'add', 'del', 'mv', 'mvchg'];
/** "status key" per row, in output order, plus the changed column names. */
const rows = (d, keyCol = 0) =>
  Array.from(d.st).map((s, i) => {
    const cols = (d.chg[i] || []).map((k) => d.columns[k].name);
    return `${WORD[s]}${cols.length ? ' ' + cols.join('+') : ''}`;
  });
const keys = (d) => d.keyCols.map((k) => d.columns[k].name);

describe('keys', () => {
  it('picks the preferred name that is unique and never empty on both sides', () => {
    const d = D('id,name\n1,A\n2,B\n', 'id,name\n2,B\n1,A\n');
    assert.deepEqual(keys(d), ['id']);
    assert.equal(d.keyMode, 'setting');
    assert.deepEqual(rows(d), ['eq', 'mv']);
  });
  it('skips a preferred column that repeats or is empty, falls back to any unique column', () => {
    const d = D('id,sku,name\n1,s1,A\n1,s2,B\n', 'id,sku,name\n1,s2,B\n1,s1,A\n');
    assert.deepEqual(keys(d), ['sku']);
    const e = D('id,ref\n,r1\n,r2\n', 'id,ref\n,r2\n,r1\n');
    assert.deepEqual(keys(e), ['ref']);
    assert.equal(e.keyMode, 'auto');
  });
  it('names are matched ignoring case and in the order given', () => {
    const d = D('Email,Name\na@x,A\nb@x,B\n', 'Email,Name\nb@x,B\na@x,A\n', { keyColumns: ['name', 'email'] });
    assert.deepEqual(keys(d), ['Name']);
  });
  it('needs some overlap, or it is not a key', () => {
    const d = D('id,v\n1,a\n2,a\n', 'id,v\n3,a\n4,a\n');
    assert.deepEqual(keys(d), []);
    assert.equal(d.keyMode, 'none');
  });
  it('composite keys: from the settings and by hand', () => {
    const a = 'country,city,pop\nVN,Hanoi,8\nVN,Hue,1\nFR,Paris,2\n';
    const b = 'country,city,pop\nFR,Paris,2\nVN,Hue,1.5\nVN,Hanoi,8\n';
    const d = D(a, b, { keyColumns: ['country+city'] });
    assert.deepEqual(keys(d), ['country', 'city']);
    assert.deepEqual(rows(d), ['eq', 'mvchg pop', 'mv']);
    const e = D(a, b, { keys: ['city'] });
    assert.deepEqual(keys(e), ['city']);
    assert.equal(e.keyMode, 'explicit');
  });
  it('finds a composite key on its own when no single column is unique', () => {
    const d = D('country,city,pop\nVN,Hanoi,8\nVN,Hue,1\nFR,Hue,1\n', 'country,city,pop\nFR,Hue,1\nVN,Hue,1\nVN,Hanoi,9\n', { keyColumns: [] });
    assert.deepEqual(keys(d), ['country', 'city']);
    assert.equal(d.keyMode, 'auto');
  });
  it('an explicit key that repeats is matched by occurrence, with a warning', () => {
    const d = D('k,v\na,1\na,2\nb,3\n', 'k,v\na,2\nb,3\na,1\n', { keys: ['k'] });
    assert.deepEqual(d.summary.duplicates, { left: 1, right: 1 });
    assert.match(d.warnings[0], /not unique/);
    assert.deepEqual(rows(d), ['chg v', 'chg v', 'mv']);
  });
  it('keys for this file name win over the settings', () => {
    const d = D('id,code\n1,x\n2,y\n', 'id,code\n2,y\n1,x\n', { fileKeys: ['code'] });
    assert.deepEqual(keys(d), ['code']);
    assert.equal(d.keyMode, 'file');
  });
  it('a key that is unique on one side only is still used when chosen by hand', () => {
    const d = D('id,v\n1,a\n1,b\n', 'id,v\n1,a\n', { keys: ['id'] });
    assert.deepEqual(rows(d), ['eq', 'del']);
  });
});

describe('rows by key', () => {
  it('added, removed, changed, unchanged, moved', () => {
    const a = 'id,name,qty\n1,A,1\n2,B,2\n3,C,3\n4,D,4\n';
    const b = 'id,name,qty\n4,D,4\n1,A,1\n2,B,5\n5,E,5\n';
    const d = D(a, b);
    assert.deepEqual(rows(d), ['eq', 'chg qty', 'del', 'add', 'mv']);
    assert.equal(c.summaryText(d.summary), '1 added, 1 removed, 1 changed in 1 column, 1 moved');
  });
  it('sorting, column order, quoting and number spelling are not changes', () => {
    const a = 'id,name,price\n1,"Alice",10\n2,Bob,1.0\n3,"Carol, Jr.",5\n';
    const b = 'price,name,id\n5,"Carol, Jr.",3\n1,"Bob",2\n1e1,Alice,1\n';
    const d = D(a, b, { ignoreRowOrder: true });
    assert.deepEqual(rows(d), ['eq', 'eq', 'eq']);
    assert.equal(c.summaryText(d.summary), 'no differences');
    assert.ok(d.summary.columnsReordered);
    const e = D(a, b);
    assert.equal(e.summary.moved, 2);
    assert.equal(e.summary.changed, 0);
  });
  it('moves are counted separately and can be ignored', () => {
    const a = 'id,v\n1,a\n2,b\n3,c\n';
    const b = 'id,v\n3,c\n1,a\n2,B\n';
    assert.deepEqual(rows(D(a, b)), ['eq', 'chg v', 'mv']);
    assert.deepEqual(rows(D(a, b, { ignoreRowOrder: true })), ['eq', 'chg v', 'eq']);
  });
  it('whitespace, case and empty = missing options', () => {
    const a = 'id,v,w\n1, a ,\n';
    const b = 'id,v\n1,A\n';
    assert.deepEqual(rows(D(a, b)), ['chg v']);
    assert.deepEqual(rows(D(a, b, { ignoreCase: true })), ['eq']);
    assert.deepEqual(rows(D(a, b, { ignoreCase: true, trimWhitespace: false })), ['chg v']);
    // w is a removed column: not a cell change. A short row's missing cell equals an empty one.
    assert.deepEqual(rows(D('id,v,w\n1,a,\n', 'id,v,w\n1,a\n')), ['eq']);
    assert.deepEqual(rows(D('id,v,w\n1,a,\n', 'id,v,w\n1,a\n', { emptyEqualsMissing: false })), ['chg w']);
    assert.deepEqual(rows(D('id,v,w\n1,a,x\n', 'id,v,w\n1,a\n')), ['chg w']);
  });
  it('ignored columns are shown, not counted', () => {
    const d = D('id,v,updated_at\n1,a,t1\n2,b,t2\n', 'id,v,updated_at\n1,a,t9\n2,c,t9\n', { ignoreColumns: ['updated_at'] });
    assert.deepEqual(rows(d), ['eq', 'chg v']);
    assert.deepEqual(d.ign, [[2], [2]]);
    assert.equal(d.summary.ignored, 2);
    assert.ok(d.columns[2].ignored);
    assert.equal(c.summaryText(d.summary), '1 changed in 1 column (2 ignored)');
    const e = D('id,a_ts,b_ts\n1,1,1\n', 'id,a_ts,b_ts\n1,2,2\n', { ignoreColumns: ['*_ts'] });
    assert.equal(c.summaryText(e.summary), 'no differences counted (2 ignored)');
  });
  it('an ignored column is never the key', () => {
    const d = D('id,v\n1,a\n2,a\n', 'id,v\n2,a\n1,a\n', { ignoreColumns: ['id'] });
    assert.deepEqual(keys(d), []);
    assert.equal(d.keyMode, 'none');
  });
  it('duplicate keys pair up by occurrence', () => {
    const d = D('id,v\n1,a\n1,a\n2,c\n', 'id,v\n1,a\n2,c\n1,a\n1,d\n');
    // id repeats: it is skipped as a preferred key and no other column works, so rows align by content.
    assert.equal(d.keyMode, 'none');
    const e = D('id,v\n1,a\n1,b\n2,c\n', 'id,v\n1,a\n2,c\n1,b\n1,d\n', { keys: ['id'] });
    assert.deepEqual(rows(e), ['eq', 'eq', 'add', 'mv']);
    assert.equal(e.summary.duplicates.left, 1);
    assert.equal(e.summary.duplicates.right, 2);
  });
  it('empty sides', () => {
    assert.deepEqual(rows(D('id,v\n1,a\n', 'id,v\n')), ['del']);
    assert.deepEqual(rows(D('id,v\n', 'id,v\n1,a\n')), ['add']);
    assert.deepEqual(rows(D('', '')), []);
    assert.deepEqual(rows(D('', 'id,v\n1,a\n')), ['add']);
    assert.equal(D('', 'id,v\n1,a\n').summary.columnsAdded, 2);
  });
});

describe('columns', () => {
  it('added, removed, reordered', () => {
    const d = D('a,b,c\n1,2,3\n', 'c,a,d\n3,1,4\n', { keyColumns: ['a'] });
    assert.deepEqual(d.columns.map((x) => `${x.name}:${x.st}`), ['a:eq', 'b:del', 'd:add', 'c:eq']);
    assert.ok(d.summary.columnsReordered);
    assert.equal(c.summaryText(d.summary), '1 column added, 1 column removed');
  });
  it('a renamed column is detected by its content', () => {
    const a = 'id,full_name,age\n1,Ann Lee,30\n2,Bo Ng,41\n3,Cy Do,52\n';
    const b = 'id,name,age\n1,Ann Lee,30\n2,Bo Ng,41\n3,Cy Do,53\n';
    const d = D(a, b);
    const ren = d.columns.find((x) => x.st === 'ren');
    assert.deepEqual([ren.from, ren.name], ['full_name', 'name']);
    assert.equal(d.summary.columnsRenamed, 1);
    assert.deepEqual(rows(d), ['eq', 'eq', 'chg age']);
  });
  it('a renamed key column still keys the comparison', () => {
    const d = D('ID,v\n1,a\n2,b\n', 'identifier,v\n2,b\n1,a\n');
    assert.deepEqual(keys(d), ['identifier']);
    assert.deepEqual(rows(d), ['eq', 'mv']);
  });
  it('columns with unrelated content are not paired', () => {
    const d = D('id,colour\n1,red\n2,blue\n', 'id,size\n1,L\n2,M\n');
    assert.deepEqual(d.columns.map((x) => x.st), ['eq', 'del', 'add']);
  });
  it('names match exactly first, then ignoring case', () => {
    const d = D('id,Name,name\n1,a,b\n', 'id,name,Name\n1,b,a\n');
    assert.deepEqual(d.columns.map((x) => `${x.name}:${x.li}>${x.ri}`), ['id:0>0', 'Name:1>2', 'name:2>1']);
    assert.ok(d.summary.columnsReordered);
    assert.deepEqual(rows(d), ['eq']);
    const e = D('id,Email\n1,a\n', 'id,email\n1,a\n');
    assert.deepEqual(e.columns.map((x) => x.st), ['eq', 'eq']);
  });
  it('wide tables with many unmatched columns do not try every pair', () => {
    const cols = (p) => Array.from({ length: 30 }, (_, i) => p + i).join(',');
    const d = D(`${cols('a')}\n${Array(30).fill(1).join(',')}\n`, `${cols('b')}\n${Array(30).fill(1).join(',')}\n`);
    assert.equal(d.columns.length, 60);
  });
});

describe('rows by content (no key)', () => {
  it('aligns unchanged rows and pairs edited ones', () => {
    const a = 'x,y\n1,a\n2,b\n3,c\n4,d\n';
    const b = 'x,y\n1,a\n2,B\n4,d\n5,e\n';
    const d = D(a, b, { keys: [] });
    assert.equal(d.keyMode, 'explicit');
    assert.deepEqual(d.keyCols, []);
    assert.deepEqual(d.notes, ['Rows aligned by content, as chosen (no key)']);
    assert.deepEqual(rows(d), ['eq', 'chg y', 'del', 'eq', 'add']);
    // The same without a choice: x is unique and shared, so it is the key.
    assert.deepEqual(keys(D(a, b, { keyColumns: [] })), ['x']);
  });
  it('a row that moved is a move, not a removal and an addition', () => {
    const a = 'city\nHanoi\nHue\nParis\nRome\n';
    const b = 'city\nHue\nParis\nRome\nHanoi\n';
    const d = D(a, b, { keys: [] });
    assert.deepEqual(rows(d), ['mv', 'eq', 'eq', 'eq']);
    assert.equal(d.summary.moved, 1);
    assert.deepEqual(rows(D(a, b, { keys: [], ignoreRowOrder: true })), ['eq', 'eq', 'eq', 'eq']);
  });
  it('a row that moved and changed', () => {
    const a = 'p,q,r\n1,a,x\n2,b,y\n3,c,z\n';
    const b = 'p,q,r\n2,b,y\n3,c,z\n1,a,X\n';
    const d = D(a, b, { keys: [] });
    assert.deepEqual(rows(d), ['mvchg r', 'eq', 'eq']);
  });
  it('rows that share boilerplate do not pair up by it', () => {
    const mk = (names) => 'name,status,country\n' + names.map((n) => `${n},active,VN`).join('\n') + '\n';
    const d = D(mk(['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Fay']), mk(['Ann', 'Bo', 'Cy', 'Di', 'Gus', 'Hal']), { keys: [] });
    assert.deepEqual(rows(d), ['eq', 'eq', 'eq', 'eq', 'del', 'del', 'add', 'add']);
  });
  it('long tables beyond the exact LCS size', () => {
    // No column is unique (so no key), and rows repeat (so no unique anchors): Myers' diff.
    const mk = (f) => 'a,b,c\n' + Array.from({ length: 3000 }, (_, i) => `${i % 50},${i % 7},${f(i)}`).join('\n') + '\n';
    const d = D(mk((i) => i % 3), mk((i) => (i === 1500 ? 'x' : i % 3)), { keyColumns: [] });
    assert.equal(d.keyMode, 'none');
    assert.equal(d.summary.changed, 1);
    assert.equal(d.summary.unchanged, 2999);
    const e = D(mk((i) => i % 3), 'a,b,c\n' + mk((i) => i % 3).split('\n').slice(2).join('\n'), { keyColumns: [] });
    assert.equal(e.summary.unchanged, 2999);
    assert.equal(e.summary.removed, 1);
  });
});

describe('no shared columns', () => {
  it('every row is removed or added', () => {
    const d = D('a,b\n1,2\n', 'x_col,y_col\nq,r\ns,t\n');
    assert.deepEqual(rows(d), ['del', 'add', 'add']);
  });
});

describe('summary text', () => {
  it('reads as a sentence', () => {
    const s = { added: 3, removed: 1, changed: 12, moved: 2, unchanged: 0, changedColumns: 4, ignored: 0, columnsAdded: 0, columnsRemoved: 0, columnsRenamed: 1, columnsReordered: false, duplicates: { left: 0, right: 0 } };
    assert.equal(c.summaryText(s), '3 added, 1 removed, 12 changed in 4 columns, 2 moved, 1 column renamed');
    assert.equal(c.summaryText({ ...s, added: 0, removed: 0, changed: 0, moved: 0, columnsRenamed: 0, ignored: 3 }), 'no differences counted (3 ignored)');
  });
});

describe('session', () => {
  const session = () => {
    const s = new c.Session();
    s.load('left', { text: 'id,name,v\n1,Ann,1\n2,Bo,2\n3,Cy,3\n' });
    s.load('right', { text: 'id,name,v,w\n3,Cy,3,x\n1,Ann,1.0,\n2,Bo,5,\n4,Di,4,\n' });
    s.compare({}, { left: true, right: true });
    return s;
  };
  it('windows of rows hold both sides aligned to the output columns', () => {
    const s = session();
    const w = s.window(0, 100);
    assert.equal(w.l.length, 4);
    assert.deepEqual(w.l[0], ['1', 'Ann', '1', null]);
    assert.deepEqual(w.r[0], ['1', 'Ann', '1.0', '']);
    assert.deepEqual(w.l[2], [null, null, null, null]);
    assert.deepEqual(w.r[2], ['4', 'Di', '4', '']);
    assert.deepEqual(w.r[3], ['3', 'Cy', '3', 'x']);
    assert.deepEqual(s.window(3, 4).l.length, 1);
  });
  it('search finds rows by text, in one column or any', () => {
    const s = session();
    assert.deepEqual(s.search({ text: 'bo', caseSensitive: false, regex: false, column: -1 }).rows, [1]);
    assert.deepEqual(s.search({ text: 'bo', caseSensitive: true, regex: false, column: -1 }).rows, []);
    assert.deepEqual(s.search({ text: '^[34]$', caseSensitive: false, regex: true, column: 0 }).rows, [2, 3]);
    assert.deepEqual(s.search({ text: '^[34]$', caseSensitive: false, regex: true, column: 2 }).rows, [2, 3]);
    assert.deepEqual(s.search({ text: '^[34]$', caseSensitive: false, regex: true, column: 1 }).rows, []);
    assert.equal(s.search({ text: '(', caseSensitive: false, regex: true, column: -1 }).error, 'Not a valid regular expression');
  });
  it('lines map rows back to the source', () => {
    const s = session();
    assert.deepEqual(s.lines('left'), [2, 3, 4]);
  });
  it('swap and reload', () => {
    const s = session();
    s.swap();
    const r = s.compare({}, { left: true, right: true });
    assert.equal(r.summary.removed, 1);
    assert.equal(r.summary.columnsRemoved, 1);
  });
});

describe('regressions', () => {
  const sum = (a, b, o) => c.summaryText(D(a, b, o).summary);
  it('padded numbers equal their short spelling, whatever the length', () => {
    assert.equal(sum('id,x\n1,0.1\n2,0.25\n', 'id,x\n1,0.1000000000000000\n2,0.2500000000000000\n'), 'no differences');
    assert.equal(sum('id,x\n1,1.5\n2,1e16\n', 'id,x\n1,1.500000000000000000\n2,10000000000000000\n'), 'no differences');
  });
  it('out-of-range numbers are not collapsed to Infinity or 0', () => {
    assert.equal(sum('id,v\n1,1e400\n2,1e-400\n', 'id,v\n1,9e999\n2,-3e-500\n'), '2 changed in 1 column');
  });
  it('decimal commas in semicolon files', () => {
    assert.equal(sum('id;amount\n1;1,5\n2;2,25\n', 'id;amount\n1;1,50\n2;2,250\n'), 'no differences');
    assert.equal(sum('id;amount\n1;1,5\n', 'id;amount\n1;1,6\n'), '1 changed in 1 column');
  });
  it('line ends inside quoted cells are not changes', () => {
    assert.equal(sum('id,note\n1,"a\nb"\n', 'id,note\r\n1,"a\r\nb"\r\n'), 'no differences');
  });
  it('both sides agree on the header', () => {
    const s0 = new c.Session();
    s0.load('left', { text: 'Product,Colour\nChair,Red\nTable,Blue\nLamp,Green\n' });
    s0.load('right', { text: 'Product,Colour\nChair,Red\nTable,Blue\nLamp,Red\n' });
    const d = s0.compare({}, { left: true, right: true });
    assert.deepEqual(d.columns.map((x) => x.name), ['Product', 'Colour']);
    assert.equal(c.summaryText(d.summary), '1 changed in 1 column');
    const s = new c.Session();
    s.load('left', { text: 'Product,Colour\nChair,Red\nTable,Blue\nLamp,Green\n' });
    s.load('right', { text: 'Product,Colour\n' });
    const r = s.compare({}, { left: true, right: true });
    assert.equal(r.summary.removed, 3);
    assert.ok(r.sides.left.header && r.sides.right.header);
    assert.deepEqual(s.lines('left'), [2, 3, 4]);
  });
  it('blank rows (,, or spaces) are skipped and keep the key', () => {
    const base = 'id,name,qty\n1,a,1\n2,b,2\n3,c,3\n4,d,4\n5,e,5\n6,f,6\n';
    const d = D(base + ',,\n,,\n', base.replace('6,f,6', '6,f,7') + ',,\n  \n');
    assert.equal(d.keyMode, 'setting');
    assert.equal(c.summaryText(d.summary), '1 changed in 1 column');
    assert.deepEqual(d.warnings, []);
  });
  it('a small shared domain is not a rename', () => {
    const d = D('id,active,name\n1,true,a\n2,false,b\n3,true,c\n', 'id,name,verified\n1,a,true\n2,b,true\n3,c,false\n');
    assert.equal(c.summaryText(d.summary), '1 column added, 1 column removed');
    const e = D('id,active\n1,true\n2,false\n3,true\n', 'id,is_active\n1,true\n2,false\n3,true\n');
    assert.equal(e.summary.columnsRenamed, 1);
  });
  it('key values are not compared as numbers', () => {
    const d = D('section,title\n1.1,Intro\n1.10,Tenth\n1.2,Second\n', 'section,title\n1.1,Intro\n1.10,Tenth (rev)\n1.2,Second\n', { keyColumns: ['section'] });
    assert.deepEqual(keys(d), ['section']);
    assert.deepEqual(d.warnings, []);
    assert.equal(c.summaryText(d.summary), '1 changed in 1 column');
    const e = D('section,title\n1.1,Intro\n1.10,Tenth\n1.2,Second\n', 'section,title\n1.1,Intro\n1.10,Tenth (rev)\n1.2,Second\n', { keys: ['section'] });
    assert.deepEqual(e.warnings, []);
  });
  it('pandas header with an empty index name', () => {
    const t = c.parseTable(',name,price\n0,apple,1.5\n1,pear,2\n');
    assert.ok(t.header);
    assert.deepEqual(t.columns, ['Column 1', 'name', 'price']);
    assert.ok(!c.parseTable(',apple,red\n1,pear,green\n2,fig,blue\n').header);
  });
  it('wide numeric tables without a named key pick one column', () => {
    const rows = Array.from({ length: 200 }, (_, i) => [i, i * 1.5, i * 2.25].join(',')).join('\n');
    const d = D('m0,m1,m2\n' + rows + '\n', 'm0,m1,m2\n' + rows + '\n');
    // m0 only numbers the rows (0..n-1), so the next unique column is the key.
    assert.deepEqual(keys(d), ['m1']);
  });
});

describe('review round 2', () => {
  const sum = (a, b, o) => c.summaryText(D(a, b, o).summary);
  const cmp = (a, b, la = {}, ra = {}) => {
    const s = new c.Session();
    s.load('left', { text: a, ...la });
    s.load('right', { text: b, ...ra });
    return s.compare({}, { left: true, right: true });
  };
  it('tab files keep grouped thousands and lists as text', () => {
    assert.equal(sum('id\tamount\n1\t1,000\n2\t2\n', 'id\tamount\n1\t1\n2\t2\n'), '1 changed in 1 column');
    assert.equal(sum('id\ttags\n1\t1,2\n', 'id\ttags\n1\t1,20\n'), '1 changed in 1 column');
  });
  it('a .csv with semicolons and decimal commas is split on semicolons', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `${i};Item ${i};1,7`).join('\n');
    const t = c.parseTable('id;name;price\n' + rows + '\n', { hint: ',' });
    assert.equal(t.delimiter, ';');
    assert.deepEqual(t.columns, ['id', 'name', 'price']);
  });
  it('row numbers are not a key', () => {
    const d = cmp(',city,population\n0,Paris,2100000\n1,Rome,2800000\n2,Oslo,700000\n', ',city,population\n0,Berlin,3600000\n1,Paris,2100000\n2,Rome,2800000\n3,Oslo,700000\n');
    assert.equal(c.summaryText(d.summary), '1 added, 3 changed in 1 column');
    const e = cmp('#,city,population\n1,Paris,2100000\n2,Rome,2800000\n3,Oslo,700000\n', '#,city,population\n1,Oslo,700000\n2,Paris,2100000\n3,Rome,2800000\n');
    assert.deepEqual(e.keyCols.map((k) => e.columns[k].name), ['city']);
    // Only the renumbered `#` differs: the populations still pair up.
    assert.equal(c.summaryText(e.summary), '3 changed in 1 column, 1 moved');
  });
  it('Title Case and plain-word headers are headers', () => {
    for (const t of ['Name,City\nAlice,Paris\nBob,Rome\nCarol,Oslo\n', 'name,city\nalice,paris\n', 'country,capital\nfrance,paris\n', 'key,value\nfoo,bar\n', 'lang,code\nenglish,en\n', 'word,translation\nhello,xin chao\n'])
      assert.ok(c.parseTable(t).header, t);
    const d = cmp('Name,City\nAlice,Paris\nBob,Rome\nCarol,Oslo\n', 'City,Name\nParis,Alice\nRome,Bob\nOslo,Carol\n');
    assert.equal(c.summaryText(d.summary), 'no differences');
  });
  it('the same unknown names in another order are headers on both sides', () => {
    const d = cmp('Foo,Bar\nAlice,Paris\nBob,Rome\n', 'Bar,Foo\nParis,Alice\nRome,Bob\n');
    assert.ok(d.sides.left.header && d.sides.right.header);
    assert.equal(c.summaryText(d.summary), 'no differences');
  });
  it('a trailing delimiter on every line keeps the header', () => {
    const t = c.parseTable('id,name,\n1,A,\n2,B,\n');
    assert.ok(t.header);
    assert.deepEqual(t.columns.slice(0, 2), ['id', 'name']);
    assert.equal(sum('id,name,\n1,A,\n2,B,\n', 'name,id,\nA,1,\nB,2,\n'), 'no differences');
  });
  it('a header set by hand on one side is followed by the other', () => {
    const d = cmp('Alpha,Beta\nAlice,Paris\nBob,Rome\nCarol,Oslo\n', 'Alpha,Beta\nAlice,Paris\nBob,Milan\nCarol,Oslo\n', { header: true });
    assert.ok(d.sides.right.header);
    assert.equal(c.summaryText(d.summary), '1 changed in 1 column');
  });
  it('opposite names are not a rename', () => {
    const d = D('id,active\n1,Y\n2,N\n3,Y\n4,N\n', 'id,inactive\n1,N\n2,Y\n3,N\n4,Y\n');
    assert.equal(d.summary.columnsRenamed, 0);
    assert.equal(c.summaryText(d.summary), '1 column added, 1 column removed');
    assert.ok(c.relatedNames('full_name', 'Name') && c.relatedNames('active', 'is_active') && c.relatedNames('isActive', 'active') && !c.relatedNames('paid', 'unpaid'));
  });
  it('a renamed column is found when the other side grew in between', () => {
    const name = (i) => `Person ${i * 7919}`;
    const L = 'id,full_name\n' + Array.from({ length: 30 }, (_, k) => `${k * 3},${name(k * 3)}`).join('\n') + '\n';
    const R = 'id,name_full\n' + Array.from({ length: 90 }, (_, i) => `${i},${name(i)}`).join('\n') + '\n';
    const d = D(L, R);
    assert.equal(d.summary.columnsRenamed, 1);
    assert.equal(d.summary.added, 60);
  });
  it('a quoted empty value is a record', () => {
    assert.equal(sum('v\na\n""\nb\n', 'v\na\nb\n'), '1 removed');
    assert.equal(c.parseTable('a,b\n1,2\n,\n').rows.length, 1);
  });
});
