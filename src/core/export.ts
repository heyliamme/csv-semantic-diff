// The comparison written out: a Markdown table for a pull request, a daff-style
// highlighter CSV, or JSON. In the CSV, every cell that a spreadsheet could read as a
// formula is defused; in Markdown, every value is an inline code span, so nothing in
// the data turns into a mention, a link, an image or HTML when it is pasted.
import { ADD, CHG, DEL, MV, MVCHG, summaryText, type DiffResult } from './diff';
import { quoteField, type Delimiter, type Table } from './parse';

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A cell that would run as a formula when the export is opened in a spreadsheet (`=`,
 * `+`, `-`, `@`, a tab or a return at the start) gets a leading apostrophe, as
 * spreadsheets themselves do to keep text as text. Plain numbers are left alone.
 */
export function defuse(v: string): string {
  if (!v) return v;
  const c = v[0];
  if (c !== '=' && c !== '+' && c !== '-' && c !== '@' && c !== '\t' && c !== '\r' && c !== '|') return v;
  if ((c === '+' || c === '-') && PLAIN_NUMBER.test(v)) return v;
  return "'" + v;
}

export interface ExportSides {
  left: Table;
  right: Table;
  leftLabel: string;
  rightLabel: string;
}

/** The two cells of a comparison row for one output column; `undefined` when the side lacks it. */
function cells(d: DiffResult, s: ExportSides, i: number, k: number): [string | undefined, string | undefined] {
  const c = d.columns[k];
  const l = d.li[i] >= 0 && c.li >= 0 ? s.left.rows[d.li[i]][c.li] : undefined;
  const r = d.ri[i] >= 0 && c.ri >= 0 ? s.right.rows[d.ri[i]][c.ri] : undefined;
  return [l, r];
}

const STATUS_WORD = ['unchanged', 'changed', 'added', 'removed', 'moved', 'changed and moved'];

/** Changed rows as a Markdown table, with old → new in changed cells. */
export function toMarkdown(d: DiffResult, s: ExportSides, limit = 500): string {
  const md = mdValue;
  const code = (v: string) => '`' + v.replace(/`/g, "'").replace(/[\r\n]+/g, ' ') + '`';
  const lines: string[] = [`${code(s.leftLabel)} → ${code(s.rightLabel)}: ${summaryText(d.summary)}`];
  const keys = d.keyCols.map((k) => d.columns[k].name);
  if (keys.length) lines.push(`Rows matched by ${keys.map(code).join(' + ')}.`);
  else if (d.n) lines.push('No key column: rows aligned by content.');
  const colNotes = d.columns.filter((c) => c.st !== 'eq').map((c) => (c.st === 'ren' ? `renamed ${code(c.from!)} → ${code(c.name)}` : c.st === 'add' ? `added ${code(c.name)}` : `removed ${code(c.name)}`));
  if (colNotes.length) lines.push(`Columns: ${colNotes.join(', ')}.`);
  const changed: number[] = [];
  let total = 0;
  for (let i = 0; i < d.n; i++)
    if (d.st[i] !== 0) {
      total++;
      if (changed.length < limit) changed.push(i);
    }
  if (!changed.length) return lines.join('\n') + '\n';
  // Only the columns involved: the key, the changed ones, and added or removed ones.
  const show = new Set<number>(d.keyCols);
  for (const i of changed) for (const k of d.chg[i] || []) show.add(k);
  d.columns.forEach((c, k) => c.st !== 'eq' && show.add(k));
  if (!d.keyCols.length) for (let k = 0; k < Math.min(3, d.columns.length); k++) show.add(k);
  const cols = [...show].sort((a, b) => a - b);
  lines.push('', `| | ${cols.map((k) => (d.columns[k].st === 'ren' ? `${md(d.columns[k].from!)} → ${md(d.columns[k].name)}` : md(d.columns[k].name))).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  const mark = ['', '~', '+', '−', '↕', '↕~'];
  for (const i of changed) {
    const st = d.st[i];
    const diffs = new Set(d.chg[i] || []);
    const row = cols.map((k) => {
      const [l, r] = cells(d, s, i, k);
      if (st === ADD) return md(r ?? '');
      if (st === DEL) return md(l ?? '');
      if (diffs.has(k)) return `~~${md(l ?? '')}~~ → ${md(r ?? '')}`;
      return md(r ?? l ?? '');
    });
    lines.push(`| ${mark[st]} | ${row.join(' | ')} |`);
  }
  if (total > changed.length) lines.push('', `… and ${total - changed.length} more rows.`);
  return lines.join('\n') + '\n';
}

/**
 * A value as Markdown that shows exactly that text: an inline code span (with a fence
 * longer than any run of backticks in it), pipes escaped for the table, line breaks as
 * spaces. Empty stays empty.
 */
export function mdValue(v: string): string {
  const t = v.replace(/\r\n?|\n/g, ' ');
  if (!t) return '';
  let longest = 0;
  let run = 0;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) === 96) longest = Math.max(longest, ++run);
    else run = 0;
  }
  const fence = '`'.repeat(longest + 1);
  const pad = t[0] === '`' || t[t.length - 1] === '`' || (t[0] === ' ' && t[t.length - 1] === ' ' && t.trim()) ? ' ' : '';
  return fence + pad + t.replace(/\|/g, '\\|') + pad + fence;
}

/**
 * The shortest arrow (`->`, `-->`, …) that occurs in no cell, so old->new is
 * unambiguous: one longer than the longest run of dashes before a `>`, found in a
 * single pass over the text.
 */
function pickArrow(d: DiffResult, s: ExportSides): string {
  let longest = 0;
  const scan = (v: string) => {
    if (v.indexOf('->') < 0) return;
    let run = 0;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 45) run++;
      else {
        if (c === 62 && run > longest) longest = run;
        run = 0;
      }
    }
  };
  for (const t of [s.left, s.right]) {
    for (const c of t.columns) scan(c);
    for (const r of t.rows) for (const v of r) if (v !== undefined) scan(v);
  }
  return '-'.repeat(longest + 1) + '>';
}

/**
 * daff's highlighter format: the first column holds the action (`@@` header, `+++`
 * added, `---` removed, `->` changed, `:` moved, `!` schema), a changed cell is
 * `old->new`, and a renamed column is `old->new` in the header.
 */
export function toHighlighterCsv(d: DiffResult, s: ExportSides, delimiter: Delimiter = ','): string {
  const arrow = pickArrow(d, s);
  const q = (v: string) => quoteField(v, delimiter);
  // The action column is the format's own; data cells are defused before they are composed.
  const line = (action: string, vals: string[]) => [q(action), ...vals.map(q)].join(delimiter);
  const cell = (v: string | undefined) => defuse(v ?? '');
  const out: string[] = [];
  const schema = d.columns.some((c) => c.st === 'add' || c.st === 'del');
  if (schema) out.push(line('!', d.columns.map((c) => (c.st === 'add' ? '+++' : c.st === 'del' ? '---' : ''))));
  out.push(line(arrow === '->' ? '@@' : `@@${arrow}`, d.columns.map((c) => (c.st === 'ren' ? `${cell(c.from)}${arrow}${cell(c.name)}` : cell(c.name)))));
  for (let i = 0; i < d.n; i++) {
    const st = d.st[i];
    const diffs = new Set(d.chg[i] || []);
    const action = st === ADD ? '+++' : st === DEL ? '---' : st === CHG || st === MVCHG ? arrow : st === MV ? ':' : '';
    const row = d.columns.map((c, k) => {
      const [l, r] = cells(d, s, i, k);
      if (st === ADD) return cell(r);
      if (st === DEL) return cell(l);
      if (diffs.has(k)) return `${cell(l)}${arrow}${cell(r)}`;
      return cell(r ?? l);
    });
    out.push(line(action, row));
  }
  return out.join('\n') + '\n';
}

export function toJson(d: DiffResult, s: ExportSides): string {
  const keys = d.keyCols.map((k) => d.columns[k].name);
  const rows: unknown[] = [];
  for (let i = 0; i < d.n; i++) {
    const st = d.st[i];
    if (st === 0) continue;
    const entry: Record<string, unknown> = { status: STATUS_WORD[st] };
    if (d.li[i] >= 0) entry.leftLine = s.left.lines[d.li[i]];
    if (d.ri[i] >= 0) entry.rightLine = s.right.lines[d.ri[i]];
    if (keys.length) {
      const src = d.ri[i] >= 0 ? 'ri' : 'li';
      entry.key = Object.fromEntries(d.keyCols.map((k) => [d.columns[k].name, cells(d, s, i, k)[src === 'ri' ? 1 : 0] ?? '']));
    }
    if (st === ADD || st === DEL) {
      entry.cells = Object.fromEntries(d.columns.filter((c) => (st === ADD ? c.ri >= 0 : c.li >= 0)).map((c) => [c.name, cells(d, s, i, d.columns.indexOf(c))[st === ADD ? 1 : 0] ?? '']));
    } else if (d.chg[i]) {
      entry.changes = Object.fromEntries(
        (d.chg[i] as number[]).map((k) => {
          const [l, r] = cells(d, s, i, k);
          return [d.columns[k].name, { old: l ?? null, new: r ?? null }];
        }),
      );
    }
    rows.push(entry);
  }
  return (
    JSON.stringify(
      {
        left: s.leftLabel,
        right: s.rightLabel,
        keys,
        summary: { ...d.summary, text: summaryText(d.summary) },
        columns: d.columns.map((c) => ({ name: c.name, status: c.st === 'eq' ? 'unchanged' : c.st === 'add' ? 'added' : c.st === 'del' ? 'removed' : 'renamed', ...(c.from !== undefined ? { from: c.from } : {}), ...(c.key ? { key: true } : {}), ...(c.ignored ? { ignored: true } : {}) })),
        rows,
      },
      null,
      2,
    ) + '\n'
  );
}
