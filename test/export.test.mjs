import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');

const S = (a, b, opts = {}) => {
  const s = new c.Session();
  s.labels = { left: 'a.csv', right: 'b.csv' };
  s.load('left', { text: a });
  s.load('right', { text: b });
  s.compare(opts, { left: true, right: true });
  return s;
};

describe('defusing formulas', () => {
  it('prefixes what a spreadsheet would run', () => {
    for (const v of ['=SUM(A1)', '+1+1', '-1+1', '@cmd', '\tx', '\rx', '|x', '=1']) assert.equal(c.defuse(v), "'" + v, v);
  });
  it('leaves numbers and text alone', () => {
    for (const v of ['-5', '+5', '-1.5e3', '5', 'abc', '', 'a=b', ' =x']) assert.equal(c.defuse(v), v, v);
  });
});

describe('markdown', () => {
  it('summary, keys and a table of the changed rows with old → new', () => {
    const md = S('id,name,v\n1,Ann,1\n2,Bo,2\n3,Cy,3\n', 'id,name,v\n3,Cy,3\n1,Ann,1.0\n2,Bo,5\n4,Di,4\n').export('markdown');
    assert.equal(
      md,
      '`a.csv` → `b.csv`: 1 added, 1 changed in 1 column, 1 moved\nRows matched by `id`.\n\n| | `id` | `v` |\n|---|---|---|\n| ~ | `2` | ~~`2`~~ → `5` |\n| + | `4` | `4` |\n| ↕ | `3` | `3` |\n',
    );
  });
  it('shows removed rows, added and renamed columns, and escapes pipes and formulas', () => {
    const md = S('id,full_name,x\n1,"A|B",=1\n2,Bo,2\n3,Cy,3\n', 'id,name,y\n1,"A|C",5\n2,Bo,6\n').export('markdown');
    assert.ok(md.includes('Columns: renamed `full_name` → `name`, removed `x`, added `y`.'), md);
    assert.ok(md.includes('| − | `3` | `Cy` | `3` |  |'), md);
    assert.ok(md.includes('| ~ | `1` | ~~`A\\|B`~~ → `A\\|C` | `=1` | `5` |'), md);
  });
  it('values are shown literally: no mentions, links, HTML or apostrophes', () => {
    const md = S('id,v\n1,-5%\n2,a\n', 'id,v\n1,-6%\n2,see @acme/team ![x](https://a.example/t.png) <img src=x> `tick`\n').export('markdown');
    assert.ok(md.includes('~~`-5%`~~ → `-6%`'), md);
    assert.ok(md.includes('`` see @acme/team ![x](https://a.example/t.png) <img src=x> `tick` ``'), md);
  });
  it('counts the rows left out once each, moved and changed included', () => {
    const md = S('id,v\n1,a\n2,b\n3,c\n', 'id,v\n3,c2\n2,b2\n1,a2\n').export('markdown', 1);
    assert.ok(md.endsWith('… and 2 more rows.\n'), md);
  });
  it('long runs of dashes pick the arrow in linear time', () => {
    const t0 = Date.now();
    const csv = S('id,v\n1,"' + '-'.repeat(200000) + '>"\n2,a\n', 'id,v\n1,x\n2,b\n').export('csv');
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(csv.startsWith('@@' + '-'.repeat(200001) + '>,'));
  });
  it('says so when nothing changed, and caps long lists', () => {
    assert.equal(S('id\n1\n', 'id\n1\n').export('markdown'), '`a.csv` → `b.csv`: no differences\nRows matched by `id`.\n');
    const many = 'id\n' + Array.from({ length: 30 }, (_, i) => i).join('\n') + '\n';
    const md = S(many, 'id\n').export('markdown', 10);
    assert.ok(md.endsWith('… and 20 more rows.\n'), md);
    assert.equal(md.split('\n').filter((l) => l.startsWith('| −')).length, 10);
  });
});

describe('highlighter CSV (daff style)', () => {
  it('actions in the first column, old->new in changed cells', () => {
    const csv = S('id,name,v\n1,Ann,1\n2,Bo,2\n3,Cy,3\n', 'id,name,v\n3,Cy,3\n1,Ann,1.0\n2,Bo,5\n4,Di,4\n').export('csv');
    assert.equal(csv, '@@,id,name,v\n,1,Ann,1.0\n->,2,Bo,2->5\n+++,4,Di,4\n:,3,Cy,3\n');
  });
  it('schema row for added and removed columns, renamed columns in the header', () => {
    const csv = S('id,full_name,x\n1,A,1\n2,B,3\n', 'id,name,y\n1,A,2\n').export('csv');
    assert.equal(csv.split('\n')[0], '!,,,---,+++');
    assert.equal(csv.split('\n')[1], '@@,id,full_name->name,x,y');
    assert.equal(csv.split('\n')[2], ',1,A,1,2');
    assert.equal(csv.split('\n')[3], '---,2,B,3,');
  });
  it('picks a longer arrow when the data contains ->, quotes, and defuses formulas', () => {
    const csv = S('id,v\n1,"a->b"\n2,=x\n', 'id,v\n1,"a->c"\n2,=y\n').export('csv');
    assert.equal(csv, '@@-->,id,v\n-->,1,a->b-->a->c\n-->,2,\'=x-->\'=y\n');
    assert.ok(S('id,v\n1,"x,y"\n', 'id,v\n1,"x,z"\n').export('csv').includes('"x,y->x,z"'));
  });
  it('removed rows keep the left values; tabs for TSV', () => {
    const csv = S('id\tv\n1\ta\n2\tb\n', 'id\tv\n1\ta\n').export('csv');
    assert.equal(csv, '@@\tid\tv\n\t1\ta\n---\t2\tb\n');
  });
});

describe('json', () => {
  it('summary, columns and changed rows with lines', () => {
    const j = JSON.parse(S('id,name,v\n1,Ann,1\n2,Bo,2\n3,Cy,3\n', 'id,name,v,w\n3,Cy,3,\n1,Ann,1.0,\n2,Bo,5,\n4,Di,4,\n').export('json'));
    assert.equal(j.left, 'a.csv');
    assert.deepEqual(j.keys, ['id']);
    assert.equal(j.summary.text, '1 added, 1 changed in 1 column, 1 moved, 1 column added');
    assert.deepEqual(j.columns[3], { name: 'w', status: 'added' });
    assert.ok(j.columns[0].key);
    assert.deepEqual(j.rows[0], { status: 'changed', leftLine: 3, rightLine: 4, key: { id: '2' }, changes: { v: { old: '2', new: '5' } } });
    assert.deepEqual(j.rows[1], { status: 'added', rightLine: 5, key: { id: '4' }, cells: { id: '4', name: 'Di', v: '4', w: '' } });
    assert.deepEqual(j.rows[2], { status: 'moved', leftLine: 4, rightLine: 2, key: { id: '3' } });
  });
});
