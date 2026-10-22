// One comparison, held where the data lives (a worker thread): both tables, the result,
// and the questions the view asks about it: a window of rows, a search, an export.
// Nothing here knows about VS Code or the DOM.
import { diffTables, type DiffOptions, type DiffResult, type Summary } from './diff';
import { toHighlighterCsv, toJson, toMarkdown } from './export';
import { agreeOnHeader, parseTable, type Delimiter, type Table } from './parse';
import type { KeyMode } from './keys';
import type { Column } from './columns';

export type Side = 'left' | 'right';

export interface SideInput {
  text: string;
  delimiter?: Delimiter | 'auto';
  hint?: Delimiter;
  header?: boolean | 'auto';
  /** Problems found before parsing (an encoding that couldn't be used), shown with the side's warnings. */
  warnings?: string[];
}

/** What the view learns about one side once it is parsed. */
export interface SideInfo {
  rows: number;
  columns: number;
  delimiter: Delimiter;
  delimiterAuto: boolean;
  header: boolean;
  headerAuto: boolean;
  warnings: string[];
  empty: boolean;
}

/** The result as the view receives it: plain arrays, nothing it can't serialise. */
export interface ResultView {
  columns: Column[];
  keyCols: number[];
  keyMode: KeyMode;
  n: number;
  st: number[];
  li: number[];
  ri: number[];
  chg: (number[] | 0)[];
  ign: (number[] | 0)[];
  summary: Summary;
  warnings: string[];
  notes: string[];
  sides: Record<Side, SideInfo>;
}

/** A match in a cell: start and end offsets in the raw value. */
export type Span = [number, number];

export interface Window {
  from: number;
  /** The search the marks belong to (see `search`). */
  sid?: number;
  /**
   * Search matches in the window, by row offset and output column: left and right spans,
   * or 0. Worked out in the worker, so the view never runs the user's pattern itself.
   */
  marks?: Record<number, Record<number, [Span[] | 0, Span[] | 0]>>;
  /** The output columns the cells are for, when not all of them (very wide tables). */
  cols?: number[];
  /** Per row, per output column: the cell, or null where that side has no cell. */
  l: (string | null)[][];
  r: (string | null)[][];
}

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  regex: boolean;
  /** Output column to search in, or -1 for all. */
  column: number;
}

export type ExportFormat = 'markdown' | 'csv' | 'json';

export class Session {
  /** Each side as read on its own. */
  parsed: Partial<Record<Side, Table>> = {};
  /** The sides as compared: the same, once both agree on whether there is a header. */
  tables: Partial<Record<Side, Table>> = {};
  labels: Record<Side, string> = { left: 'Left', right: 'Right' };
  result?: DiffResult;
  /** Bumped by every search; the marks of the last one, by comparison row then output column. */
  sid = 0;
  private marks = new Map<number, Record<number, [Span[] | 0, Span[] | 0]>>();

  load(side: Side, input: SideInput): SideInfo {
    const t = parseTable(input.text, { delimiter: input.delimiter, hint: input.hint, header: input.header });
    if (input.warnings?.length) {
      t.readWarnings.unshift(...input.warnings);
      t.warnings.unshift(...input.warnings);
    }
    this.parsed[side] = t;
    this.tables[side] = t;
    this.result = undefined;
    return Session.info(t, input.text);
  }

  swap() {
    this.parsed = { left: this.parsed.right, right: this.parsed.left };
    this.tables = { left: this.tables.right, right: this.tables.left };
    this.labels = { left: this.labels.right, right: this.labels.left };
    this.result = undefined;
  }

  static info(t: Table, text: string): SideInfo {
    return { rows: t.rows.length, columns: t.columns.length, delimiter: t.delimiter, delimiterAuto: t.delimiterAuto, header: t.header, headerAuto: t.headerAuto, warnings: t.warnings, empty: !text.trim() };
  }

  /** Lines of the source where each data row starts, for jumping to a row (as compared). */
  lines(side: Side): number[] {
    return this.tables[side]?.lines ?? [];
  }

  compare(options: Partial<DiffOptions>, texts: Record<Side, boolean>): ResultView {
    if (!this.parsed.left || !this.parsed.right) throw new Error('Both sides must be loaded first');
    const [L, R] = agreeOnHeader(this.parsed.left, this.parsed.right);
    this.tables = { left: L, right: R };
    const d = (this.result = diffTables(L, R, options));
    this.marks.clear();
    return {
      columns: d.columns,
      keyCols: d.keyCols,
      keyMode: d.keyMode,
      n: d.n,
      st: Array.from(d.st),
      li: Array.from(d.li),
      ri: Array.from(d.ri),
      chg: d.chg,
      ign: d.ign,
      summary: d.summary,
      warnings: d.warnings,
      notes: d.notes,
      sides: { left: { ...Session.info(L, texts.left ? 'x' : ''), empty: !texts.left }, right: { ...Session.info(R, texts.right ? 'x' : ''), empty: !texts.right } },
    };
  }

  /** Rows `from`..`to`; with `cols`, only those output columns (in that order). */
  window(from: number, to: number, cols?: number[]): Window {
    const d = this.result;
    const L = this.tables.left!;
    const R = this.tables.right!;
    const l: (string | null)[][] = [];
    const r: (string | null)[][] = [];
    if (!d) return { from, l, r };
    const end = Math.min(to, d.n);
    const ks = cols ? cols.filter((k) => k >= 0 && k < d.columns.length) : d.columns.map((_, k) => k);
    const picked = ks.map((k) => d.columns[k]);
    let marks: Window['marks'];
    for (let i = from; i < end; i++) {
      const m = this.marks.get(i);
      if (m) {
        const row: Record<number, [Span[] | 0, Span[] | 0]> = {};
        let any = false;
        for (const k of ks)
          if (m[k]) {
            row[k] = m[k];
            any = true;
          }
        if (any) (marks ??= {})[i - from] = row;
      }
      const a = d.li[i] >= 0 ? L.rows[d.li[i]] : undefined;
      const b = d.ri[i] >= 0 ? R.rows[d.ri[i]] : undefined;
      l.push(picked.map((c) => (a && c.li >= 0 ? a[c.li] ?? null : null)));
      r.push(picked.map((c) => (b && c.ri >= 0 ? b[c.ri] ?? null : null)));
    }
    const w: Window = cols ? { from, cols: ks, l, r } : { from, l, r };
    w.sid = this.sid;
    if (marks) w.marks = marks;
    return w;
  }

  /**
   * Rows (indices into the comparison) with a cell that matches, up to a limit. The
   * matches themselves are kept for `window`: every cell the view highlights was matched
   * here, inside the time box, so a pattern that backtracks without end can only stall
   * the worker (which the host replaces), never the view.
   */
  search(q: SearchQuery, limit = 100_000, budgetMs = 4000): { rows: number[]; capped: boolean; error?: string; sid: number } {
    const sid = ++this.sid;
    this.marks.clear();
    const d = this.result;
    if (!d || !q.text) return { rows: [], capped: false, sid };
    let re: RegExp;
    try {
      re = new RegExp(q.regex ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), q.caseSensitive ? 'g' : 'gi');
    } catch {
      return { rows: [], capped: false, error: 'Not a valid regular expression', sid };
    }
    const L = this.tables.left!;
    const R = this.tables.right!;
    const ks = q.column >= 0 ? [q.column] : d.columns.map((_, k) => k);
    const rows: number[] = [];
    const spans = (v: string | undefined): Span[] | 0 => {
      if (v === undefined || v === '') return 0;
      const out: Span[] = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v))) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        out.push([m.index, m.index + m[0].length]);
      }
      return out.length ? out : 0;
    };
    // Time-boxed, so a slow pattern over a big table returns what it found (the host
    // also stops the worker if a single cell never finishes).
    const deadline = Date.now() + budgetMs;
    for (let i = 0; i < d.n; i++) {
      if ((i & 255) === 255 && Date.now() > deadline) return { rows, capped: true, sid };
      const a = d.li[i] >= 0 ? L.rows[d.li[i]] : undefined;
      const b = d.ri[i] >= 0 ? R.rows[d.ri[i]] : undefined;
      let row: Record<number, [Span[] | 0, Span[] | 0]> | undefined;
      for (const k of ks) {
        const c = d.columns[k];
        if (!c) continue;
        const sl = a && c.li >= 0 ? spans(a[c.li]) : 0;
        const sr = b && c.ri >= 0 ? spans(b[c.ri]) : 0;
        if (sl || sr) (row ??= {})[k] = [sl, sr];
      }
      if (row) {
        this.marks.set(i, row);
        rows.push(i);
        if (rows.length >= limit) return { rows, capped: true, sid };
      }
    }
    return { rows, capped: false, sid };
  }

  export(format: ExportFormat, limit?: number): string {
    const d = this.result;
    if (!d) throw new Error('Nothing to export yet');
    const s = { left: this.tables.left!, right: this.tables.right!, leftLabel: this.labels.left, rightLabel: this.labels.right };
    if (format === 'markdown') return toMarkdown(d, s, limit);
    if (format === 'csv') return toHighlighterCsv(d, s, this.tables.right!.delimiter === '\t' ? '\t' : ',');
    return toJson(d, s);
  }
}
