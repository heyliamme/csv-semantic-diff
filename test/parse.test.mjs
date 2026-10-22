import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const c = require('../dist/core.js');

const P = (text, options) => c.parseTable(text, options);

describe('parse', () => {
  it('reads a plain file with a header', () => {
    const t = P('id,name\n1,Alice\n2,Bob\n');
    assert.deepEqual(t.columns, ['id', 'name']);
    assert.deepEqual(t.rows, [['1', 'Alice'], ['2', 'Bob']]);
    assert.deepEqual(t.lines, [2, 3]);
    assert.equal(t.headerLine, 1);
    assert.equal(t.delimiter, ',');
    assert.ok(t.header && t.headerAuto && t.delimiterAuto);
  });

  it('RFC 4180 quoting: embedded delimiters, quotes and newlines', () => {
    const t = P('id,text\n1,"a, b"\n2,"say ""hi"""\n3,"line one\nline two"\n4,plain\n');
    assert.deepEqual(t.rows.map((r) => r[1]), ['a, b', 'say "hi"', 'line one\nline two', 'plain']);
    // Lines count the embedded newline: row 4 starts on line 6.
    assert.deepEqual(t.lines, [2, 3, 4, 6]);
  });

  it('CRLF, CR and a byte order mark', () => {
    const t = P('﻿id,name\r\n1,A\r\n2,B\r\n');
    assert.deepEqual(t.columns, ['id', 'name']);
    assert.deepEqual(t.rows, [['1', 'A'], ['2', 'B']]);
    assert.deepEqual(t.lines, [2, 3]);
    const cr = P('id,name\r1,A\r2,B');
    assert.deepEqual(cr.rows, [['1', 'A'], ['2', 'B']]);
    assert.deepEqual(cr.lines, [2, 3]);
    const quoted = P('id,text\r\n1,"a\r\nb"\r\n2,c\r\n');
    assert.equal(quoted.rows[0][1], 'a\r\nb');
    assert.deepEqual(quoted.lines, [2, 4]);
  });

  it('ragged rows: short rows read as missing cells, long rows add columns', () => {
    const t = P('a,b,c\n1,2\n3,4,5,6\n');
    assert.deepEqual(t.columns, ['a', 'b', 'c', 'Column 4']);
    assert.deepEqual(t.rows, [['1', '2'], ['3', '4', '5', '6']]);
    assert.equal(t.rows[0][2], undefined);
    assert.equal(t.warnings.length, 2);
    assert.match(t.warnings[0], /more fields than the header/);
    assert.match(t.warnings[1], /fewer fields/);
  });

  it('empty lines are skipped, empty cells and trailing delimiters are kept', () => {
    const t = P('a,b\n\n1,\n\n,2\n3,4,\n');
    assert.deepEqual(t.rows, [['1', ''], ['', '2'], ['3', '4', '']]);
    assert.deepEqual(t.lines, [3, 5, 6]);
    assert.deepEqual(P('a,b\n1,2,').rows, [['1', '2', '']]);
  });

  it('detects tab, semicolon and pipe delimiters', () => {
    assert.equal(P('id\tname\n1\tA\n2\tB\n').delimiter, '\t');
    assert.equal(P('id;name;x\n1;A;2,5\n2;B;3,5\n').delimiter, ';');
    assert.equal(P('id|name\n1|A\n2|B\n').delimiter, '|');
    assert.equal(P('id,name\n1,"A;B"\n2,"C;D"\n').delimiter, ',');
    // One column, no delimiter at all: the hint, else a comma.
    assert.equal(P('name\nA\nB\n').delimiter, ',');
    assert.equal(P('name\nA\nB\n', { hint: '\t' }).delimiter, '\t');
  });

  it('a hint from the extension wins when it is about as consistent', () => {
    assert.equal(P('a\tb,c\n1\t2,3\n', { hint: '\t' }).delimiter, '\t');
    assert.equal(P('a\tb,c\n1\t2,3\n', { hint: ',' }).delimiter, ',');
    assert.equal(P('a,b\n1,2\n', { hint: '\t' }).delimiter, ',');
  });

  it('a fixed delimiter is used as given', () => {
    const t = P('a;b,c\n1;2,3\n', { delimiter: ';' });
    assert.deepEqual(t.columns, ['a', 'b,c']);
  });

  it('header detection', () => {
    assert.equal(P('id,name\n1,A\n').header, true);
    assert.equal(P('1,A\n2,B\n').header, false);
    assert.equal(P('2024-01-01,10\n2024-01-02,20\n').header, false);
    assert.equal(P('alice,bob\ncarol,dan\n').header, false);
    assert.equal(P('first_name,last_name\nAnn,Lee\nBo,Ng\n').header, true);
    assert.equal(P('name,city\nAnn,Hanoi\nBo,Hue\n').header, true);
    assert.equal(P('id,ref\n,r1\n,r2\n').header, true);
    assert.equal(P('Ann,Hanoi\nBo,Hue\n').header, false);
    assert.equal(P('city\nHanoi\nHue\n').header, true);
    assert.equal(P('id,id\n1,2\n').header, false); // repeated names are not a header
    assert.equal(P('id,name\n').header, true);
    const forced = P('id,name\n1,A\n', { header: false });
    assert.deepEqual(forced.columns, ['Column 1', 'Column 2']);
    assert.deepEqual(forced.rows, [['id', 'name'], ['1', 'A']]);
    assert.deepEqual(forced.lines, [1, 2]);
    assert.equal(P('1,A\n2,B\n', { header: true }).columns.join(), '1,A');
  });

  it('repeated and empty header names get distinct names', () => {
    assert.deepEqual(P('a,,a,A\n1,2,3,4\n', { header: true }).columns, ['a', 'Column 2', 'a (2)', 'A']);
  });

  it('a quoted field that is never closed, and text after a closing quote', () => {
    const t = P('a,b\n1,"open\n2,x\n');
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0][1], 'open\n2,x\n');
    assert.match(t.warnings[0], /never closed/);
    const stray = P('a,b\n1,"x"y\n');
    assert.equal(stray.rows[0][1], 'xy');
    assert.match(stray.warnings[0], /after a closing quote/);
  });

  it('huge fields and many columns', () => {
    const big = 'x'.repeat(2_000_000);
    const t = P(`a,b\n1,"${big}"\n`);
    assert.equal(t.rows[0][1].length, 2_000_000);
    const wide = Array.from({ length: 2000 }, (_, i) => 'c' + i).join(',');
    assert.equal(P(`${wide}\n${wide}\n`).columns.length, 2000);
  });

  it('empty input', () => {
    const t = P('');
    assert.deepEqual(t.rows, []);
    assert.deepEqual(t.columns, []);
    assert.equal(P('\n\n').rows.length, 0);
  });

  it('writes fields back out with quoting only where needed', () => {
    assert.equal(c.quoteField('plain'), 'plain');
    assert.equal(c.quoteField('a,b'), '"a,b"');
    assert.equal(c.quoteField('say "hi"'), '"say ""hi"""');
    assert.equal(c.quoteField('two\nlines'), '"two\nlines"');
    assert.equal(c.quoteField(' padded'), '" padded"');
    assert.equal(c.quoteField('a,b', '\t'), 'a,b');
  });
});

describe('normalisation', () => {
  const N = (s, o = {}) => c.normalizeCell(s, { ...c.DEFAULT_NORMALIZE, ...o });
  it('numbers by value', () => {
    for (const [a, b] of [['1', '1.0'], ['1e3', '1000'], ['0.5', '.5'], ['-0', '0'], ['1.50', '1.5'], ['+5', '5'], ['1E+2', '100'], ['12.', '12']]) assert.equal(N(a), N(b), `${a} = ${b}`);
    assert.notEqual(N('1'), N('1.0001'));
    assert.notEqual(N('1'), N('01'));
    assert.equal(N('007'), '007'); // leading zeros: a code, not a number
    assert.equal(N('0'), '0');
    assert.equal(N('1'), N('1.0000000000000000'));
    assert.equal(N('1e16'), N('10000000000000000'));
    assert.notEqual(N('1e400'), N('9e999'));
    assert.notEqual(N('1e-400'), N('0'));
    assert.equal(N('0.0'), '0');
    assert.equal(N('1,000'), '1,000');
    assert.equal(N('1,000', { thousandsSeparators: true }), N('1000'));
    assert.equal(N('1,5', { decimalComma: true }), N('1.5'));
    assert.equal(N('1,5'), '1,5');
    assert.equal(N('1 234 567.5', { thousandsSeparators: true }), N('1234567.5'));
    assert.equal(N('1.0', { normalizeNumbers: false }), '1.0');
  });
  it('big integers exactly', () => {
    assert.notEqual(N('90071992547409931'), N('90071992547409932'));
    assert.equal(N('90071992547409931'), N('90071992547409931.0'));
    assert.equal(N('1e99999999999999999999'), N('10e99999999999999999998'));
  });
  it('whitespace and case', () => {
    assert.equal(N('  a '), 'a');
    assert.equal(N('  a ', { trimWhitespace: false }), '  a ');
    assert.equal(N('  1.0 '), N('1'));
    assert.equal(N('a\r\nb'), N('a\nb'));
    assert.equal(N('Ab', { ignoreCase: true }), 'ab');
    assert.equal(N('Ab'), 'Ab');
  });
  it('name patterns for ignored columns', () => {
    assert.ok(c.nameMatcher('updated_at')('Updated_At'));
    assert.ok(c.nameMatcher('*_ts')('created_ts'));
    assert.ok(!c.nameMatcher('*_ts')('ts'));
    assert.ok(c.nameMatcher('col?')('col1'));
    assert.ok(!c.nameMatcher('')('x'));
    assert.ok(c.nameMatcher('a.b')('a.b') && !c.nameMatcher('a.b')('axb'));
  });
});
