// Turns comparison rows into HTML for the grid. Pure functions over the row model and a
// window of cells, so they can be tested outside the DOM; every piece of document text
// goes through `esc`.
import type { Column } from '../src/core/columns';
import type { Span, Window } from '../src/core/session';

export const EQ = 0;
export const CHG = 1;
export const ADD = 2;
export const DEL = 3;
export const MV = 4;
export const MVCHG = 5;

export const STATUS_CLASS = ['eq', 'chg', 'add', 'del', 'mv', 'mvchg'];
export const STATUS_WORD = ['unchanged', 'changed', 'added', 'removed', 'moved', 'changed and moved'];
export const STATUS_MARK = ['', '~', '+', '−', '↕', '↕~'];

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A cell's text as shown: one line, control characters made visible. */
export function cellText(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v.replace(/\r\n|\r|\n/g, '↵').replace(/\t/g, '→');
}

export interface RowModel {
  st: number[];
  li: number[];
  ri: number[];
  chg: (number[] | 0)[];
  ign: (number[] | 0)[];
}

export interface RenderContext {
  rows: RowModel;
  columns: Column[];
  /** Output columns to show, in order. */
  visibleCols: number[];
  view: 'unified' | 'sideBySide';
  /** Left side's own column order (output indices with li ≥ 0), for side by side. */
  leftCols: number[];
  rightCols: number[];
  lines: { left: number[]; right: number[] } | undefined;
  /** Rows (full indices) that match the current search. */
  hits?: Set<number>;
  /** The search whose marks windows must carry to be highlighted (marks come from the worker). */
  sid?: number;
}

/**
 * A cell's text, escaped, with the search matches the worker found marked. The view
 * never runs the user's pattern: a pattern that backtracks without end would freeze it.
 */
export function mark(raw: string | null | undefined, spans: Span[] | 0 | undefined): string {
  if (raw === null || raw === undefined) return '';
  if (!spans) return esc(cellText(raw));
  let out = '';
  let last = 0;
  for (const [a, b] of spans) {
    if (a < last || b > raw.length) continue;
    out += esc(cellText(raw.slice(last, a))) + '<mark>' + esc(cellText(raw.slice(a, b))) + '</mark>';
    last = b;
  }
  return out + esc(cellText(raw.slice(last)));
}

/** A screen reader's label for a cell whose row or value changed: the text alone says nothing. */
const said = (name: string, v: string | null | undefined, what: string) => ` aria-label="${esc(name)}: ${esc(cellText(v) || 'empty')}, ${esc(what)}"`;

const cell = (cls: string, html: string, id: string, title?: string, extra = '') =>
  `<div class="cell${cls ? ' ' + cls : ''}" role="gridcell" id="${id}"${title ? ` title="${esc(title)}"` : ''}${extra}>${html}</div>`;

/** Gutter cells: the two line numbers and the status mark. */
function gutter(ctx: RenderContext, i: number, v: number, which: 'unified' | 'left' | 'right'): string {
  const st = ctx.rows.st[i];
  const li = ctx.rows.li[i];
  const ri = ctx.rows.ri[i];
  const ln = (side: 'left' | 'right', idx: number) => (idx >= 0 && ctx.lines ? ctx.lines[side][idx] ?? '' : '');
  const mark = (pin: string) => `<div class="cell st ${pin}" role="gridcell" id="c-${v}-st" aria-label="${STATUS_WORD[st]}"><span aria-hidden="true">${STATUS_MARK[st]}</span></div>`;
  if (which === 'left') return `<div class="cell ln g0" role="rowheader" id="c-${v}-ll" title="Line in the left file">${ln('left', li)}</div>${mark('g1')}`;
  if (which === 'right') return `<div class="cell ln rl" role="rowheader" id="c-${v}-rl" title="Line in the right file">${ln('right', ri)}</div>`;
  return `<div class="cell ln g0" role="rowheader" id="c-${v}-ll" title="Line in the left file">${ln('left', li)}</div><div class="cell ln g1" role="rowheader" id="c-${v}-rl" title="Line in the right file">${ln('right', ri)}</div>${mark('g2')}`;
}

/**
 * One row. `v` is its index among the visible rows (ids and aria), `i` its index in the
 * comparison. Without a window the cells are placeholders of the right shape.
 */
export function rowHtml(ctx: RenderContext, i: number, v: number, win: Window | undefined, selected: boolean): string {
  const st = ctx.rows.st[i];
  const changed = new Set(ctx.rows.chg[i] || []);
  const ignored = new Set(ctx.rows.ign[i] || []);
  const hit = ctx.hits?.has(i);
  const marks = hit && win?.marks && win.sid === ctx.sid ? win.marks[i - win.from] : undefined;
  const ml = (k: number) => marks?.[k]?.[0];
  const mr = (k: number) => marks?.[k]?.[1];
  const l = win ? win.l[i - win.from] : undefined;
  const r = win ? win.r[i - win.from] : undefined;
  const loading = !win ? ' loading' : '';
  const cls = `row ${STATUS_CLASS[st]}${selected ? ' sel' : ''}${hit ? ' hit' : ''}${loading}`;
  let cells: string;
  if (ctx.view === 'unified') {
    cells = gutter(ctx, i, v, 'unified');
    for (const k of ctx.visibleCols) {
      const c = ctx.columns[k];
      const id = `c-${v}-${k}`;
      const colCls = c.st === 'add' ? ' cadd' : c.st === 'del' ? ' cdel' : '';
      if (!win) {
        cells += cell('ph' + colCls, '', id);
        continue;
      }
      const lv = l![k];
      const rv = r![k];
      if (st === ADD) cells += cell('a' + colCls, mark(rv, mr(k)), id, rv ?? undefined, said(c.name, rv, 'added row'));
      else if (st === DEL) cells += cell('d' + colCls, mark(lv, ml(k)), id, lv ?? undefined, said(c.name, lv, 'removed row'));
      else if (changed.has(k) || ignored.has(k)) {
        const kind = ignored.has(k) ? 'i' : 'c';
        const old = lv === null ? '<span class="miss">missing</span>' : mark(lv, ml(k));
        const now = rv === null ? '<span class="miss">missing</span>' : mark(rv, mr(k));
        cells += cell(kind + colCls, `<span class="old">${old}</span><span class="arr" aria-hidden="true">→</span><span class="new">${now}</span>`, id, `${cellText(lv) || '(empty)'} → ${cellText(rv) || '(empty)'}`, ` aria-label="${esc(c.name)}: ${esc(cellText(lv) || 'empty')} changed to ${esc(cellText(rv) || 'empty')}"`);
      } else {
        const val = rv ?? lv;
        cells += cell((val === null || val === undefined ? 'none' : '') + colCls, mark(val, rv !== null && rv !== undefined ? mr(k) : ml(k)), id, val ?? undefined);
      }
    }
  } else {
    cells = gutter(ctx, i, v, 'left');
    const show = new Set(ctx.visibleCols);
    for (const k of ctx.leftCols) {
      if (!show.has(k)) continue;
      const c = ctx.columns[k];
      const id = `c-${v}-${k}-l`;
      const colCls = c.st === 'del' ? ' cdel' : '';
      if (!win) {
        cells += cell('ph' + colCls, '', id);
        continue;
      }
      const lv = l![k];
      if (st === ADD) cells += cell('fill', '', id);
      else if (st === DEL) cells += cell('d' + colCls, mark(lv, ml(k)), id, lv ?? undefined, said(c.name, lv, 'removed row'));
      else if (changed.has(k)) cells += cell('cl' + colCls, mark(lv, ml(k)), id, lv ?? undefined, said(c.name, lv, `changed to ${cellText(r![k]) || 'empty'}`));
      else if (ignored.has(k)) cells += cell('il' + colCls, mark(lv, ml(k)), id, lv ?? undefined);
      else cells += cell(colCls.trim(), mark(lv, ml(k)), id, lv ?? undefined);
    }
    cells += gutter(ctx, i, v, 'right');
    for (const k of ctx.rightCols) {
      if (!show.has(k)) continue;
      const c = ctx.columns[k];
      const id = `c-${v}-${k}-r`;
      const colCls = c.st === 'add' ? ' cadd' : '';
      if (!win) {
        cells += cell('ph' + colCls, '', id);
        continue;
      }
      const rv = r![k];
      if (st === DEL) cells += cell('fill', '', id);
      else if (st === ADD) cells += cell('a' + colCls, mark(rv, mr(k)), id, rv ?? undefined, said(c.name, rv, 'added row'));
      else if (changed.has(k)) cells += cell('cr' + colCls, mark(rv, mr(k)), id, rv ?? undefined, said(c.name, rv, `changed from ${cellText(l![k]) || 'empty'}`));
      else if (ignored.has(k)) cells += cell('ir' + colCls, mark(rv, mr(k)), id, rv ?? undefined);
      else cells += cell(colCls.trim(), mark(rv, mr(k)), id, rv ?? undefined);
    }
  }
  const label = st === EQ ? '' : ` aria-label="${STATUS_WORD[st]} row"`;
  return `<div class="${cls}" role="row" id="row-${v}"${label} data-v="${v}" data-i="${i}" aria-rowindex="${v + 2}" aria-selected="${selected}">${cells}</div>`;
}

/** The column header row. */
export function headHtml(ctx: RenderContext): string {
  const head = (k: number, side?: 'l' | 'r') => {
    const c = ctx.columns[k];
    const badges =
      (c.key ? '<span class="codicon codicon-key badge-icon" title="Key column" aria-label="key"></span>' : '') +
      (c.st === 'ren' ? `<span class="badge ren" title="Renamed from ${esc(c.from!)}">was ${esc(c.from!)}</span>` : '') +
      (c.st === 'add' ? '<span class="badge add" title="Only in the right table">added</span>' : '') +
      (c.st === 'del' ? '<span class="badge del" title="Only in the left table">removed</span>' : '') +
      (c.ignored ? '<span class="badge ign" title="Differences in this column are not counted">ignored</span>' : '');
    const name = side === 'l' && c.st === 'ren' ? c.from! : c.name;
    const cls = `cell hd${c.st === 'add' ? ' cadd' : c.st === 'del' ? ' cdel' : ''}${c.key ? ' key' : ''}${c.ignored ? ' ign' : ''}`;
    return `<div class="${cls}" role="columnheader" data-col="${k}" title="${esc(c.name)}"><button class="hb" data-menu="${k}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(name)} column menu"><span class="hn">${esc(name)}</span>${badges}</button></div>`;
  };
  let h: string;
  if (ctx.view === 'unified') {
    h = `<div class="cell ln hd g0" role="columnheader" title="Line in the left file">L</div><div class="cell ln hd g1" role="columnheader" title="Line in the right file">R</div><div class="cell st hd g2" role="columnheader" aria-label="status"></div>`;
    for (const k of ctx.visibleCols) h += head(k);
  } else {
    const show = new Set(ctx.visibleCols);
    h = `<div class="cell ln hd g0" role="columnheader" title="Line in the left file">L</div><div class="cell st hd g1" role="columnheader" aria-label="status"></div>`;
    for (const k of ctx.leftCols) if (show.has(k)) h += head(k, 'l');
    h += `<div class="cell ln rl hd" role="columnheader" title="Line in the right file">R</div>`;
    for (const k of ctx.rightCols) if (show.has(k)) h += head(k, 'r');
  }
  return h;
}

/** The grid's column tracks, in ch: gutters, then one per shown column (twice for side by side). */
export function tracks(ctx: RenderContext, widths: number[]): string {
  const w = (k: number) => `${widths[k] ?? 10}ch`;
  if (ctx.view === 'unified') return `var(--lnw) var(--lnw) 2.2ch ${ctx.visibleCols.map(w).join(' ')}`;
  const show = new Set(ctx.visibleCols);
  return `var(--lnw) 2.2ch ${ctx.leftCols.filter((k) => show.has(k)).map(w).join(' ')} var(--lnw) ${ctx.rightCols.filter((k) => show.has(k)).map(w).join(' ')}`.replace(/\s+/g, ' ');
}

/** Column widths from the header and a sample of cells: 4ch to 44ch, wider for cells shown as old → new. */
export function measure(columns: Column[], sample: Window | undefined, changedCols: Set<number>): number[] {
  const len = (s: string | null | undefined) => (s ? Math.min(60, cellText(s).length) : 0);
  return columns.map((c, k) => {
    let max = Math.max(len(c.name) + (c.key ? 3 : 0) + (c.st === 'ren' ? len(c.from) + 5 : 0) + (c.st !== 'eq' ? 8 : 0), 4);
    if (sample) {
      for (let r = 0; r < Math.min(sample.l.length, 200); r++) {
        const a = len(sample.l[r][k]);
        const b = len(sample.r[r][k]);
        if (a > max) max = a;
        if (b > max) max = b;
      }
    }
    if (changedCols.has(k)) max = Math.min(max * 2 + 3, 60);
    return Math.min(44, max + 2);
  });
}
