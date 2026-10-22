import type { Column } from '../src/core/columns';
import type { Delimiter } from '../src/core/parse';
import type { ResultView, SearchQuery, Side, Window } from '../src/core/session';
import type { FromWebview, SideData, ToWebview, ViewOptions } from '../src/protocol';
import { ADD, CHG, DEL, EQ, MV, MVCHG, STATUS_WORD, cellText, esc, headHtml, measure, rowHtml, tracks, type RenderContext } from './render';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; setState(s: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

/** Rows come from the host in chunks of this many. */
const CHUNK = 100;
/** Rows above and below the viewport that are built. */
const OVERSCAN = 12;
/** Chunks kept in memory; older ones are dropped. */
const CACHE = 80;
/** Columns built at most: a table wider than this shows its first visible columns. */
const MAX_COLS = 400;
/** Entries at most in column lists (menus, the find bar's column picker). */
const MAX_LIST = 2000;

type Toggle = 'changesOnly' | 'ignoreRowOrder' | 'normalizeNumbers' | 'thousandsSeparators' | 'trimWhitespace' | 'ignoreCase' | 'emptyEqualsMissing';
const TOGGLES: [Toggle, string, string][] = [
  ['changesOnly', 'Changes only', 'Hide unchanged rows'],
  ['ignoreRowOrder', 'Ignore order', 'Rows that only changed place are not reported'],
  ['normalizeNumbers', 'Numbers', 'Compare numbers by value: 1.0 = 1 = 1e0 (007 stays text)'],
  ['thousandsSeparators', '1,000', 'Read 1,000 and 1 000 as the number 1000'],
  ['trimWhitespace', 'Trim', 'Ignore whitespace at the start and end of a cell'],
  ['ignoreCase', 'Ignore case', 'Compare text without regard to case: Alice equals alice'],
  ['emptyEqualsMissing', 'Empty = missing', 'An empty cell equals a missing one (a short row, or a column the other side lacks)'],
];

let opts: ViewOptions | undefined;
let sides: Record<Side, SideData> | undefined;
let gen = -1;
let result: ResultView | undefined;
let failure: string | undefined;
let busy: string | undefined;
/** Key columns chosen in this view (undefined: automatic). */
let keys: string[] | undefined;
const windows = new Map<number, Window>();
const inflight = new Set<number>();
let measured = false;
let widths: number[] = [];
let vis: number[] = [];
let chRows: number[] = [];
let cur = -1;
/** Selected visible row, and position in the column sequence of the view. */
const sel = { v: -1, c: -1 };
const hiddenNames = new Set<string>();
/** Row filters; the column one by name (colId), so it survives a recompute or a swap. */
const filters = { status: new Set<number>(), column: undefined as string | undefined, onlyHits: false };
let colSeq: { k: number; side?: 'l' | 'r' }[] = [];
let lines: { left: number[]; right: number[] } | undefined;
let editing = false;
let menuOpenFor: HTMLElement | undefined;
/** Which sides' parse warnings are expanded. */
const warnOpen = { left: false, right: false };
/** The output columns windows are fetched for, when the table is too wide for all. */
let windowCols: number[] | undefined;
// Find
const query: SearchQuery = { text: '', caseSensitive: false, regex: false, column: -1 };
let searchSeq = 0;
let hits: number[] = [];
let hitSet = new Set<number>();
let hitIdx = -1;
/** The worker's id for the search the current hits come from: windows carry marks for it. */
let marksSid: number | undefined;
let searchError: string | undefined;
let capped = false;
/** A query that failed (bad pattern, or stopped for taking too long): not re-run by itself. */
let failedQuery: string | undefined;

const icon = (name: string) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="bar">
  <div class="stats" id="stats" aria-live="polite"></div>
  <div class="nav">
    <button id="prev" class="icon" title="Previous change (Shift+F7 or P)" aria-label="Previous change">${icon('arrow-up')}</button>
    <span id="pos" class="pos"></span>
    <button id="next" class="icon" title="Next change (F7 or N)" aria-label="Next change">${icon('arrow-down')}</button>
  </div>
  <div class="toggles" role="group" aria-label="Comparison options">
    ${TOGGLES.map(([opt, label, title]) => `<button class="tog" data-opt="${opt}" aria-pressed="false" title="${esc(title)}">${esc(label)}</button>`).join('')}
  </div>
  <div class="actions">
    <button id="openFind" class="icon" title="Find in cells (Ctrl+F)" aria-label="Find">${icon('search')}</button>
    <button id="filter" title="Show only some rows" aria-haspopup="dialog" aria-expanded="false">${icon('filter')}<span class="t">Filter</span></button>
    <button id="columns" title="Show or hide columns" aria-haspopup="dialog" aria-expanded="false">${icon('split-horizontal')}<span class="t">Columns</span></button>
    <div class="seg" role="group" aria-label="View">
      <button data-view="unified" aria-pressed="true" title="One table; a changed cell shows old → new">Unified</button><button data-view="sideBySide" aria-pressed="false" title="The two tables next to each other, rows aligned">Side by side</button>
    </div>
    <button id="edit" aria-pressed="false" title="Edit the pasted tables here" hidden>${icon('edit')}<span class="t">Edit</span></button>
    <button id="swap" class="icon" title="Swap sides" aria-label="Swap sides">${icon('arrow-swap')}</button>
    <button id="export" title="Copy as Markdown, or save as highlighter CSV or JSON" aria-haspopup="dialog" aria-expanded="false">${icon('export')}<span class="t">Export</span></button>
  </div>
</header>
<div class="keybar" id="keybar"></div>
<div class="find" id="find" hidden role="search">
  <input id="find-q" type="text" spellcheck="false" autocomplete="off" placeholder="Find in cells" aria-label="Find in cells">
  <button class="tog small" id="find-case" aria-pressed="false" title="Match case">Aa</button>
  <button class="tog small" id="find-re" aria-pressed="false" title="Regular expression">.*</button>
  <select id="find-col" aria-label="Search in column" title="Search in one column or all"><option value="-1">All columns</option></select>
  <span id="find-count" class="pos" aria-live="polite"></span>
  <button id="find-prev" class="icon" title="Previous match (Shift+Enter, Shift+F3)" aria-label="Previous match">${icon('arrow-up')}</button>
  <button id="find-next" class="icon" title="Next match (Enter, F3)" aria-label="Next match">${icon('arrow-down')}</button>
  <button class="tog small" id="find-only" aria-pressed="false" title="Show only the rows that match">Only matches</button>
  <button id="find-close" class="icon" title="Close (Escape)" aria-label="Close find">${icon('close')}</button>
</div>
<div class="editors" id="editors" hidden>
  <div class="ed"><textarea id="ed-left" spellcheck="false" aria-label="Left table" placeholder="Paste or type a table (left)"></textarea></div>
  <div class="ed"><textarea id="ed-right" spellcheck="false" aria-label="Right table" placeholder="Paste or type a table (right)"></textarea></div>
</div>
<div class="heads" id="heads"></div>
<div class="body">
  <div id="grid" role="grid" tabindex="0" aria-label="Comparison table. Arrow keys move between cells, Enter opens the row in its file, F7 goes to the next change." aria-rowcount="0" aria-colcount="0" aria-multiselectable="false">
    <div id="head" role="row" aria-rowindex="1"></div>
    <div id="spacer"><div id="rows"></div></div>
  </div>
  <div id="problems" hidden></div>
</div>
<footer id="status"></footer>
<div id="menu" class="menu" role="dialog" hidden></div>
<div id="announce" class="sr-only" aria-live="polite"></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const gridEl = $('grid');
const headEl = $('head');
const rowsEl = $('rows');
const spacerEl = $('spacer');
const ROW = () => parseFloat(getComputedStyle(gridEl).getPropertyValue('--row')) || 24;

// --- state -----------------------------------------------------------------------------

function saveState() {
  if (!sides?.left || !sides.right) return;
  const keep = (s: SideData) => s.restore;
  vscode.setState({ left: keep(sides.left), right: keep(sides.right), keys });
}

function setSide(side: Side, data: SideData) {
  if (!sides) sides = {} as Record<Side, SideData>;
  sides[side] = data;
  const ed = $<HTMLTextAreaElement>(`ed-${side}`);
  if (data.text !== undefined && ed.value !== data.text) ed.value = data.text;
  saveState();
}

function ctx(): RenderContext | undefined {
  if (!result) return undefined;
  const r = result;
  const visibleCols = shownCols();
  return {
    rows: r,
    columns: r.columns,
    visibleCols,
    view: opts?.view ?? 'unified',
    leftCols: r.columns.map((c, k) => ({ c, k })).filter(({ c }) => c.li >= 0).sort((a, b) => a.c.li - b.c.li).map(({ k }) => k),
    rightCols: r.columns.map((c, k) => ({ c, k })).filter(({ c }) => c.ri >= 0).sort((a, b) => a.c.ri - b.c.ri).map(({ k }) => k),
    lines,
    hits: hitSet.size ? hitSet : undefined,
    sid: marksSid,
  };
}

/** What a column is called for hiding purposes: stable across recomputes. */
const colId = (c: Column) => (c.from !== undefined ? `${c.from}→${c.name}` : c.name);

/** Visible columns, all of them up to MAX_COLS; beyond that the first MAX_COLS. */
function visibleAll(): number[] {
  if (!result) return [];
  const r = result;
  return r.columns.map((_, k) => k).filter((k) => !hiddenNames.has(colId(r.columns[k])));
}
function shownCols(): number[] {
  const all = visibleAll();
  return all.length > MAX_COLS ? all.slice(0, MAX_COLS) : all;
}

/** The output column a filter name stands for now, or -1. */
function filterColumn(): number {
  if (!result || filters.column === undefined) return -1;
  const id = filters.column;
  const k = result.columns.findIndex((c) => colId(c) === id);
  if (k >= 0) return k;
  // Renamed one way or the other since (a swap reverses a rename).
  return result.columns.findIndex((c) => id === c.name || id === c.from || id === `${c.name}→${c.from}`);
}

const filtersActive = () => filters.status.size + (filters.column !== undefined ? 1 : 0) + (filters.onlyHits ? 1 : 0);

function rebuildVis() {
  vis = [];
  chRows = [];
  if (!result) return;
  const r = result;
  const only = filters.status.size ? filters.status : undefined;
  const fc = filterColumn();
  if (filters.column !== undefined && fc < 0) filters.column = undefined;
  for (let i = 0; i < r.n; i++) {
    const st = r.st[i];
    if (opts?.changesOnly && st === EQ) continue;
    if (only && !only.has(st === MVCHG ? CHG : st) && !(only.has(MV) && st === MVCHG)) continue;
    if (fc >= 0 && !(r.chg[i] && (r.chg[i] as number[]).includes(fc)) && !(r.ign[i] && (r.ign[i] as number[]).includes(fc))) continue;
    if (filters.onlyHits && !hitSet.has(i)) continue;
    if (st !== EQ) chRows.push(vis.length);
    vis.push(i);
  }
  if (cur >= chRows.length) cur = chRows.length - 1;
}

// --- rendering -------------------------------------------------------------------------

/** A selector that finds the same control after its markup is rebuilt. */
function focusKey(el: Element | null): string | undefined {
  if (!(el instanceof HTMLElement) || el === document.body) return undefined;
  for (const a of ['delim', 'header', 'paste', 'pick', 'menu', 'warn', 'act']) {
    const v = el.dataset[a];
    if (v !== undefined) return `[data-${a}="${CSS.escape(v)}"]`;
  }
  return el.id ? `#${CSS.escape(el.id)}` : undefined;
}

/** Puts focus back on the control `key` names, or on the grid when it is gone. */
function restoreFocus(key: string | undefined) {
  const el = key ? document.querySelector<HTMLElement>(key) : null;
  if (el && !el.closest('[hidden]')) el.focus();
  else if (!gridEl.hidden) gridEl.focus();
}

function render() {
  if (!sides || !opts) return;
  // The heads and the column header are rebuilt: keep keyboard focus where it was.
  const active = document.activeElement;
  const key = focusKey(active);
  renderAll();
  if (active instanceof HTMLElement && !active.isConnected && key) restoreFocus(key);
}

function renderAll() {
  document.body.classList.toggle('nodiff', !result);
  renderHeads();
  renderStats();
  renderKeybar();
  renderProblems();
  const c = ctx();
  if (!c) {
    headEl.innerHTML = '';
    rowsEl.innerHTML = '';
    spacerEl.style.height = '0px';
    renderStatus();
    return;
  }
  const shown = new Set(c.visibleCols);
  colSeq = c.view === 'unified' ? c.visibleCols.map((k) => ({ k })) : [...c.leftCols.filter((k) => shown.has(k)).map((k) => ({ k, side: 'l' as const })), ...c.rightCols.filter((k) => shown.has(k)).map((k) => ({ k, side: 'r' as const }))];
  // A very wide table fetches only the columns it shows: refetch when that set changes.
  const wanted = result!.columns.length > MAX_COLS ? c.visibleCols : undefined;
  if (String(wanted) !== String(windowCols)) {
    windowCols = wanted;
    windows.clear();
    inflight.clear();
  }
  if (sel.c >= colSeq.length) sel.c = colSeq.length - 1;
  const maxLine = Math.max(1, ...(lines ? [lines.left[lines.left.length - 1] ?? 0, lines.right[lines.right.length - 1] ?? 0] : [0]));
  gridEl.style.setProperty('--lnw', `${Math.max(3, String(maxLine).length) + 1}ch`);
  gridEl.style.setProperty('--cols', tracks(c, widths));
  gridEl.setAttribute('aria-rowcount', String(vis.length + 1));
  gridEl.setAttribute('aria-colcount', String(colSeq.length + (c.view === 'unified' ? 3 : 3)));
  headEl.innerHTML = headHtml(c);
  spacerEl.style.height = `${vis.length * ROW()}px`;
  renderRows(true);
  renderStatus();
  renderFindColumns();
}

let rafPending = false;
function scheduleRows() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderRows(false);
  });
}

/** Builds the rows near the viewport, asking the host for the chunks it doesn't have yet. */
function renderRows(force: boolean) {
  const c = ctx();
  if (!c) return;
  const rowPx = ROW();
  const top = gridEl.scrollTop;
  const first = Math.max(0, Math.floor(top / rowPx) - OVERSCAN);
  const last = Math.min(vis.length, Math.ceil((top + gridEl.clientHeight) / rowPx) + OVERSCAN);
  const need = new Set<number>();
  for (let v = first; v < last; v++) need.add(Math.floor(vis[v] / CHUNK));
  for (const k of need) request(k);
  const key = `${first}:${last}:${[...need].map((k) => (windows.has(k) ? 1 : 0)).join('')}`;
  if (!force && rowsEl.dataset.key === key) return;
  rowsEl.dataset.key = key;
  let h = '';
  for (let v = first; v < last; v++) {
    const i = vis[v];
    h += rowHtml(c, i, v, windows.get(Math.floor(i / CHUNK)), v === sel.v);
  }
  rowsEl.style.top = `${first * rowPx}px`;
  if (!vis.length && result) h = `<div class="empty-rows" role="row"><div role="gridcell">${result.n ? `No rows to show${filtersActive() ? ' with the current filters' : opts?.changesOnly ? ': nothing changed' : ''}.` : 'Both tables are empty.'}${filtersActive() ? ' <button data-act="clearFilters">Clear filters</button>' : ''}</div></div>`;
  rowsEl.innerHTML = h;
  markActive();
  trimCache(need);
}

/** A window for some columns, as rows indexed by output column like a full one. */
function spread(w: Window, width: number): Window {
  if (!w.cols) return w;
  const cols = w.cols;
  const out = (rows: (string | null)[][]) =>
    rows.map((vals) => {
      const row: (string | null)[] = [];
      row.length = width;
      for (let j = 0; j < cols.length; j++) row[cols[j]] = vals[j];
      return row;
    });
  return { from: w.from, sid: w.sid, marks: w.marks, l: out(w.l), r: out(w.r) };
}

function request(k: number) {
  const w = windows.get(k);
  // A window without the marks of the current search is shown as is and asked for again.
  if ((w && (!hitSet.size || w.sid === marksSid)) || inflight.has(k) || !result) return;
  inflight.add(k);
  post({ type: 'window', gen, from: k * CHUNK, to: Math.min(result.n, (k + 1) * CHUNK), cols: windowCols });
}

function trimCache(keep: Set<number>) {
  if (windows.size <= CACHE) return;
  for (const k of [...windows.keys()]) {
    if (keep.has(k)) continue;
    windows.delete(k);
    if (windows.size <= CACHE / 2) break;
  }
}

function renderHeads() {
  const head = (side: Side) => {
    const s = sides![side];
    const info = result?.sides[side];
    const name = side;
    const notes: string[] = [];
    if (info && !info.empty) {
      notes.push(`${info.rows.toLocaleString()} row${info.rows === 1 ? '' : 's'} × ${info.columns} column${info.columns === 1 ? '' : 's'}`);
      notes.push({ ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' }[info.delimiter] + (info.delimiterAuto ? '' : ' (set)'));
      notes.push(info.header ? 'header' : 'no header');
    }
    const n = info?.warnings.length ?? 0;
    const warn = n
      ? `<button class="warn" data-warn="${side}" aria-expanded="${warnOpen[side]}" title="${esc(info!.warnings.join('\n'))}" aria-label="${n} ${n === 1 ? 'warning' : 'warnings'} about the ${name} table: ${warnOpen[side] ? 'hide' : 'show'}">&#9888; ${n}</button>`
      : '';
    const warnList = n && warnOpen[side] ? `<ul class="side-warnings">${info!.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    const detail = s.detail && s.detail !== s.label ? s.detail : '';
    const delim = `<select data-delim="${side}" aria-label="Delimiter of the ${name} table" title="Delimiter">${[
      ['auto', 'Auto'],
      [',', 'Comma'],
      ['\t', 'Tab'],
      [';', 'Semicolon'],
      ['|', 'Pipe'],
    ]
      .map(([v, l]) => `<option value="${esc(v)}"${s.delimiter === v ? ' selected' : ''}>${l}</option>`)
      .join('')}</select>`;
    const header = `<select data-header="${side}" aria-label="Header row of the ${name} table" title="Header row">${[
      ['auto', 'Header: auto'],
      ['true', 'Header row'],
      ['false', 'No header'],
    ]
      .map(([v, l]) => `<option value="${v}"${String(s.header) === v ? ' selected' : ''}>${l}</option>`)
      .join('')}</select>`;
    return `<div class="head ${side === 'left' ? 'l' : 'r'}">
      <div class="name"><span class="label" title="${esc(s.detail ?? s.label)}">${esc(s.label)}</span>${warn}</div>
      <div class="detail">${detail ? `<span class="path">${esc(detail)}</span>` : ''}${notes.map((n) => `<span class="note">${esc(n)}</span>`).join('')}</div>
      ${warnList}
      <div class="side-actions">${delim}${header}<button data-paste="${side}" title="Replace the ${name} side with the clipboard" aria-label="Paste the clipboard into the ${name} side">Paste</button><button data-pick="${side}" title="Choose a file, an open editor or the clipboard" aria-label="Change the ${name} side…">Change…</button></div>
    </div>`;
  };
  $('heads').innerHTML = head('left') + head('right');
}

let statsHtml = '';
/** #stats is a live region: it is only written when the summary actually changes. */
function setStats(html: string) {
  if (html === statsHtml) return;
  statsHtml = html;
  $('stats').innerHTML = html;
}

function renderStats() {
  for (const id of ['prev', 'next', 'export', 'filter', 'columns']) $<HTMLButtonElement>(id).disabled = !result;
  if (busy) {
    setStats(`<span class="busy">${icon('loading~spin')} ${esc(busy)}</span>`);
    return;
  }
  if (!result) {
    setStats('');
    $('pos').textContent = '';
    return;
  }
  const s = result.summary;
  const stat = (n: number, cls: string, sym: string, word: string) => (n ? `<span class="stat ${cls}" title="${n} ${word}">${sym}${n.toLocaleString()} <span class="w">${word}</span></span>` : '');
  const cols =
    stat(s.columnsAdded, 'add', '+', s.columnsAdded === 1 ? 'column' : 'columns') +
    stat(s.columnsRemoved, 'del', '&minus;', s.columnsRemoved === 1 ? 'column' : 'columns') +
    (s.columnsRenamed ? `<span class="stat ren" title="${s.columnsRenamed} renamed">${s.columnsRenamed} <span class="w">renamed</span></span>` : '');
  const ignored = s.ignored ? `<span class="ignored" title="Cell differences in ignored columns, shown dimmed">${s.ignored} ignored</span>` : '';
  const total = s.added + s.removed + s.changed + s.moved + s.columnsAdded + s.columnsRemoved + s.columnsRenamed;
  if (!total) setStats((s.ignored ? `<span class="same partial">No differences counted</span>` : `<span class="same">&#10003; No differences</span>`) + ignored);
  else
    setStats(
      stat(s.added, 'add', '+', 'added') +
      stat(s.removed, 'del', '&minus;', 'removed') +
      stat(s.changed, 'chg', '~', s.changedColumns ? `changed in ${s.changedColumns} column${s.changedColumns === 1 ? '' : 's'}` : 'changed') +
      stat(s.moved, 'moved', '&#8597;', 'moved') +
      cols +
        ignored,
    );
  $('pos').textContent = chRows.length ? `${cur >= 0 ? cur + 1 : '–'} / ${chRows.length}` : '';
  $<HTMLButtonElement>('prev').disabled = $<HTMLButtonElement>('next').disabled = !chRows.length;
  renderFilterButton();
}

/** The Filter button says when filters hide rows, and how many are set. */
function renderFilterButton() {
  const n = result ? filtersActive() : 0;
  const btn = $('filter');
  btn.classList.toggle('on', n > 0);
  btn.querySelector('.t')!.textContent = n ? `Filter (${n})` : 'Filter';
  btn.title = n ? `${n} ${n === 1 ? 'filter hides' : 'filters hide'} rows. Click to change.` : 'Show only some rows';
}

function renderKeybar() {
  const el = $('keybar');
  if (!result || !opts) {
    el.innerHTML = '';
    el.hidden = true;
    return;
  }
  const r = result;
  const names = r.keyCols.map((k) => r.columns[k].name);
  const mode = { explicit: 'chosen here', file: `for files like ${esc(opts.fileKeysPattern ?? '')}`, setting: 'from the preferred names', auto: 'found automatically', none: '' }[r.keyMode];
  const autoBack = r.keyMode === 'explicit' ? `<button class="link" data-act="autoKey" title="Go back to the key found for you">Automatic key</button>` : '';
  const keyHtml = names.length
    ? `<span class="lbl">Key</span><button id="keychip" class="chip key" title="Rows are matched by this column. Click to change.">${icon('key')} ${names.map(esc).join(' + ')}</button><span class="muted">${mode}</span>${autoBack}`
    : `<span class="lbl">Key</span><button id="keychip" class="chip" title="Rows are aligned by content. Click to choose a key column.">${icon('key')} none: rows aligned by content</button>${autoBack}`;
  const save = names.length && (sides?.right.restore.uri || sides?.left.restore.uri) ? `<button id="saveKeys" class="link" title="Remember this key for files with a similar name">Save for files like…</button>` : '';
  const ignoring = r.columns.filter((c) => c.ignored);
  const session = ignoring.filter((c) => !opts!.ignoreColumns.some((p) => matchName(p, c.name) || (c.from !== undefined && matchName(p, c.from))));
  const chips = ignoring
    .map((c) => (session.includes(c) ? `<span class="chip">${esc(c.name)}<button data-unignore="${esc(c.name)}" aria-label="Stop ignoring ${esc(c.name)}">&times;</button></span>` : `<span class="chip saved" title="From settings: csvSemanticDiff.ignoreColumns">${esc(c.name)}</span>`))
    .join('');
  const ignoreHtml = ignoring.length ? `<span class="lbl">Ignoring</span>${chips}${session.length ? `<button id="saveIgnores" class="link">Save to settings</button>` : ''}` : '';
  const notes = [...r.notes.map((n) => `<span class="note" title="${esc(n)}">${esc(n)}</span>`), ...r.warnings.map((w) => `<span class="warn" title="${esc(w)}">&#9888; ${esc(w)}</span>`)];
  if (r.summary.columnsReordered) notes.push('<span class="note" title="The shared columns come in a different order on the right; column order is not a change">columns reordered</span>');
  const hiddenByWidth = visibleAll().length - shownCols().length;
  if (hiddenByWidth > 0) notes.push(`<span class="warn" title="Only the first ${MAX_COLS} visible columns are built. Hide columns, or use Columns › Only changed and key columns, to bring others into view.">&#9888; ${r.columns.length.toLocaleString()} columns: showing the first ${MAX_COLS} visible</span>`);
  if (filtersActive()) notes.unshift(`<span class="note filtering">Showing ${vis.length.toLocaleString()} of ${r.n.toLocaleString()} rows</span><button class="link" data-act="clearFilters">Clear filters</button>`);
  if (opts.restricted) notes.push('<span class="note restricted" title="The workspace is not trusted, so its settings for keys, ignored columns and normalisation were not applied">Restricted Mode: workspace settings not applied</span>');
  el.innerHTML = `${keyHtml}${save}${ignoreHtml}${notes.join('')}`;
  el.hidden = false;
}

function matchName(pattern: string, name: string): boolean {
  const p = pattern.trim();
  if (!p.includes('*') && !p.includes('?')) return p.toLowerCase() === name.toLowerCase();
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(name);
}

function renderProblems() {
  const el = $('problems');
  if (result) {
    el.hidden = true;
    el.innerHTML = '';
    gridEl.hidden = false;
    return;
  }
  gridEl.hidden = true;
  el.hidden = false;
  if (failure) {
    el.innerHTML = `<div class="problems"><div class="problem bad">${esc(failure)}</div></div>`;
    return;
  }
  const box = (side: Side) => {
    const s = sides![side];
    const name = side === 'left' ? 'Left' : 'Right';
    if (s.editable && !(s.text ?? '').trim())
      return `<div class="problem empty"><b>${name} is empty.</b> ${editing ? 'Paste or type a table in the box above, or use' : 'Use <em>Edit</em> to type a table, or'} <em>Paste</em> / <em>Change…</em> to load the clipboard or a file.</div>`;
    return `<div class="problem ok">${name}: ${esc(s.label)}</div>`;
  };
  el.innerHTML = busy ? `<div class="problems"><div class="problem ok">${esc(busy)}</div></div>` : `<div class="problems">${box('left')}${box('right')}</div>`;
}

/** The footer: the selected row's status, lines, key and every changed cell in full. */
function renderStatus() {
  const el = $('status');
  if (!result || sel.v < 0 || sel.v >= vis.length) {
    el.innerHTML = '';
    el.classList.remove('filled');
    return;
  }
  const r = result;
  const i = vis[sel.v];
  const st = r.st[i];
  const li = r.li[i];
  const ri = r.ri[i];
  const win = windows.get(Math.floor(i / CHUNK));
  const row = win ? { l: win.l[i - win.from], r: win.r[i - win.from] } : undefined;
  const keyText = row ? r.keyCols.map((k) => cellText(row.r[k] ?? row.l[k])).join(' + ') : '';
  const parts: string[] = [`<span class="st-${st}">${STATUS_WORD[st]}</span>`];
  if (keyText) parts.push(`<code class="path" title="Key">${esc(keyText)}</code>`);
  if (li >= 0 && lines) parts.push(`<button data-reveal="left" title="Open the left file at this row (Shift+Enter)"${sides?.left.canReveal ? '' : ' disabled'}>Left, line ${lines.left[li]}</button>`);
  if (ri >= 0 && lines) parts.push(`<button data-reveal="right" title="Open the right file at this row (Enter)"${sides?.right.canReveal ? '' : ' disabled'}>Right, line ${lines.right[ri]}</button>`);
  const changes = [...((r.chg[i] || []) as number[]), ...((r.ign[i] || []) as number[])];
  if (row && changes.length) {
    const detail = changes
      .map((k) => {
        const c = r.columns[k];
        const ign = (r.ign[i] || ([] as number[])).includes(k);
        const old = row.l[k] === null ? '<span class="miss">missing</span>' : esc(cellText(row.l[k])) || '<span class="miss">empty</span>';
        const now = row.r[k] === null ? '<span class="miss">missing</span>' : esc(cellText(row.r[k])) || '<span class="miss">empty</span>';
        return `<span class="chgd${ign ? ' ign' : ''}"><b>${esc(c.name)}</b>: <span class="old">${old}</span> → <span class="new">${now}</span></span>`;
      })
      .join(' ');
    parts.push(`<span class="changes">${detail}</span>`);
  }
  el.innerHTML = parts.join(' ');
  el.classList.add('filled');
}

let findColsHtml = '';
function renderFindColumns() {
  const sel = $<HTMLSelectElement>('find-col');
  const current = sel.value;
  const html = `<option value="-1">All columns</option>` + (result?.columns.slice(0, MAX_LIST).map((c, k) => `<option value="${k}">${esc(c.name)}</option>`).join('') ?? '');
  if (findColsHtml === html) return;
  findColsHtml = html;
  sel.innerHTML = html;
  sel.value = [...sel.options].some((o) => o.value === current) ? current : '-1';
}

// --- selection and navigation ---------------------------------------------------------

function cellIdOf(v: number, c: number): string | undefined {
  const col = colSeq[c];
  if (!col) return `c-${v}-st`;
  return `c-${v}-${col.k}${col.side ? '-' + col.side : ''}`;
}

function markActive() {
  rowsEl.querySelectorAll('.cell.active').forEach((e) => e.classList.remove('active'));
  if (sel.v < 0) {
    gridEl.removeAttribute('aria-activedescendant');
    return;
  }
  const id = cellIdOf(sel.v, sel.c);
  const el = id ? document.getElementById(id) : null;
  if (el) {
    el.classList.add('active');
    gridEl.setAttribute('aria-activedescendant', el.id);
  }
}

function scrollToRow(v: number, center: boolean) {
  const rowPx = ROW();
  const top = v * rowPx;
  const headH = headEl.offsetHeight;
  const viewTop = gridEl.scrollTop;
  const viewBottom = viewTop + gridEl.clientHeight - headH;
  if (center) gridEl.scrollTop = Math.max(0, top - gridEl.clientHeight / 2);
  else if (top < viewTop) gridEl.scrollTop = top;
  else if (top + rowPx > viewBottom) gridEl.scrollTop = top + rowPx - gridEl.clientHeight + headH;
}

function scrollToCol() {
  const id = cellIdOf(sel.v, sel.c);
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  const box = el.getBoundingClientRect();
  const g = gridEl.getBoundingClientRect();
  const gutter = (headEl.querySelector('.cell.st') as HTMLElement | null)?.getBoundingClientRect().right ?? g.left;
  if (box.left < gutter) gridEl.scrollLeft -= gutter - box.left;
  else if (box.right > g.right) gridEl.scrollLeft += box.right - g.right;
}

function select(v: number, c = sel.c, center = false) {
  const old = sel.v;
  sel.v = Math.max(0, Math.min(vis.length - 1, v));
  sel.c = Math.max(0, Math.min(colSeq.length - 1, c));
  if (old >= 0) document.getElementById(`row-${old}`)?.classList.remove('sel');
  scrollToRow(sel.v, center);
  renderRows(true);
  const rowEl = document.getElementById(`row-${sel.v}`);
  rowEl?.classList.add('sel');
  rowEl?.setAttribute('aria-selected', 'true');
  scrollToCol();
  markActive();
  renderStatus();
  const i = vis[sel.v];
  // Moving to another row says what happened to it (go() says more right after).
  if (result && sel.v !== old) $('announce').textContent = result.st[i] === EQ ? '' : `${STATUS_WORD[result.st[i]]} row`;
  if (result && result.st[i] !== EQ) {
    const at = chRows.indexOf(sel.v);
    if (at >= 0 && at !== cur) {
      cur = at;
      renderStats();
    }
  }
}

function go(i: number) {
  if (!chRows.length) return;
  cur = (i + chRows.length) % chRows.length;
  select(chRows[cur], sel.c, true);
  renderStats();
  const row = vis[chRows[cur]];
  $('announce').textContent = `Change ${cur + 1} of ${chRows.length}: ${STATUS_WORD[result!.st[row]]} row`;
}

// --- events ---------------------------------------------------------------------------

gridEl.addEventListener('scroll', scheduleRows);
new ResizeObserver(() => scheduleRows()).observe(gridEl);

function cellPos(el: HTMLElement): { v: number; c: number } | undefined {
  const row = el.closest<HTMLElement>('.row');
  if (!row) return undefined;
  const v = +row.dataset.v!;
  const cellEl = el.closest<HTMLElement>('.cell');
  const m = cellEl?.id.match(/^c-\d+-(\d+)(?:-([lr]))?$/);
  if (!m) return { v, c: sel.c < 0 ? 0 : sel.c };
  const k = +m[1];
  const side = m[2] as 'l' | 'r' | undefined;
  const c = colSeq.findIndex((x) => x.k === k && x.side === side);
  return { v, c: c < 0 ? 0 : c };
}

gridEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-menu]')) return;
  const p = cellPos(t);
  if (p) select(p.v, p.c);
});

gridEl.addEventListener('dblclick', (e) => {
  const t = e.target as HTMLElement;
  const p = cellPos(t);
  if (!p) return;
  const col = colSeq[p.c];
  const side: Side = col?.side === 'l' || e.altKey ? 'left' : col?.side === 'r' ? 'right' : rowSide(vis[p.v]);
  reveal(side, vis[p.v]);
});

/** The file a unified row opens in: the right one when it has the row, else the left. */
function rowSide(i: number): Side {
  return result && result.ri[i] >= 0 ? 'right' : 'left';
}

function reveal(side: Side, i: number) {
  if (!result || !sides) return;
  const row = side === 'left' ? result.li[i] : result.ri[i];
  if (row < 0 || !sides[side].canReveal) return;
  post({ type: 'reveal', side, row });
}

gridEl.addEventListener('keydown', (e) => {
  // Keys on the column header buttons (inside the grid) are theirs: Enter opens the menu.
  if (e.target !== gridEl) return;
  if (!vis.length || e.ctrlKey || e.metaKey || e.altKey) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Home' || e.key === 'End') && vis.length) {
      e.preventDefault();
      select(e.key === 'Home' ? 0 : vis.length - 1, sel.c);
    }
    return;
  }
  const page = Math.max(1, Math.floor((gridEl.clientHeight - headEl.offsetHeight) / ROW()) - 1);
  const move = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
  if (move !== undefined) {
    e.preventDefault();
    const from = sel.v < 0 ? (move > 0 ? -1 : vis.length) : sel.v;
    select(Math.max(0, Math.min(vis.length - 1, from + move)), sel.c < 0 ? 0 : sel.c);
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    select(sel.v < 0 ? 0 : sel.v, (sel.c < 0 ? 0 : sel.c) + (e.key === 'ArrowRight' ? 1 : -1));
  } else if (e.key === 'Home') {
    e.preventDefault();
    select(sel.v < 0 ? 0 : sel.v, 0);
  } else if (e.key === 'End') {
    e.preventDefault();
    select(sel.v < 0 ? 0 : sel.v, colSeq.length - 1);
  } else if (e.key === 'Enter' && sel.v >= 0) {
    e.preventDefault();
    const col = colSeq[sel.c];
    reveal(e.shiftKey || col?.side === 'l' ? 'left' : col?.side === 'r' ? 'right' : rowSide(vis[sel.v]), vis[sel.v]);
  }
});

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('button');
  if (menuOpenFor && !t.closest('#menu') && btn !== menuOpenFor) closeMenu();
  if (!btn || !sides || !opts) return;
  if (btn.dataset.paste) post({ type: 'paste', side: btn.dataset.paste as Side });
  else if (btn.dataset.pick) post({ type: 'pick', side: btn.dataset.pick as Side });
  else if (btn.dataset.reveal && sel.v >= 0) reveal(btn.dataset.reveal as Side, vis[sel.v]);
  else if (btn.id === 'keychip') post({ type: 'pickKeys' });
  else if (btn.id === 'saveKeys' && result) post({ type: 'saveKeys', keys: result.keyCols.map((k) => result!.columns[k].name) });
  else if (btn.dataset.unignore) post({ type: 'ignore', columns: sessionIgnores().filter((n) => n !== btn.dataset.unignore) });
  else if (btn.id === 'saveIgnores' && result) post({ type: 'saveIgnore', columns: sessionIgnores() });
  else if (btn.dataset.menu !== undefined) openColumnMenu(btn, +btn.dataset.menu);
  else if (btn.dataset.warn) {
    const side = btn.dataset.warn as Side;
    warnOpen[side] = !warnOpen[side];
    render();
  }
  else if (btn.dataset.view) setView(btn.dataset.view as ViewOptions['view']);
  else if (btn.dataset.act) act(btn);
});

document.addEventListener('change', (e) => {
  const t = e.target as HTMLSelectElement | HTMLInputElement;
  if (!sides) return;
  if (t instanceof HTMLSelectElement && (t.dataset.delim || t.dataset.header)) {
    const side = (t.dataset.delim ?? t.dataset.header) as Side;
    const row = t.closest('.side-actions')!;
    const delimiter = (row.querySelector<HTMLSelectElement>('[data-delim]')!.value as Delimiter | 'auto') || 'auto';
    const h = row.querySelector<HTMLSelectElement>('[data-header]')!.value;
    const header = h === 'auto' ? 'auto' : h === 'true';
    sides[side].delimiter = delimiter;
    sides[side].header = header;
    sides[side].restore.delimiter = delimiter;
    sides[side].restore.header = header;
    saveState();
    post({ type: 'sideOptions', side, delimiter, header });
  } else if (t instanceof HTMLInputElement && t.dataset.col !== undefined && t.type === 'checkbox') {
    const c = result?.columns[+t.dataset.col];
    if (!c) return;
    if (t.checked) hiddenNames.delete(colId(c));
    else hiddenNames.add(colId(c));
    render();
  } else if (t instanceof HTMLInputElement && t.dataset.status !== undefined && t.type === 'checkbox') {
    const st = +t.dataset.status;
    if (t.checked) filters.status.add(st);
    else filters.status.delete(st);
    rebuildVis();
    render();
  } else if (t instanceof HTMLSelectElement && t.id === 'filter-col') {
    filters.column = +t.value >= 0 && result ? colId(result.columns[+t.value]) : undefined;
    rebuildVis();
    render();
  } else if (t instanceof HTMLSelectElement && t.id === 'find-col') {
    query.column = +t.value;
    runSearch();
  }
});

/** Columns ignored in this view only (not by the settings). */
function sessionIgnores(): string[] {
  if (!result || !opts) return [];
  return result.columns.filter((c) => c.ignored && !opts!.ignoreColumns.some((p) => matchName(p, c.name) || (c.from !== undefined && matchName(p, c.from)))).map((c) => c.name);
}

function act(btn: HTMLElement) {
  const a = btn.dataset.act!;
  // The control the menu was opened from gets focus back (or the grid, if it is gone).
  const back = menuOpenFor && btn.closest('#menu') ? focusKey(menuOpenFor) : focusKey(btn);
  const done = (rerender: boolean) => {
    closeMenu();
    if (rerender) {
      rebuildVis();
      renderAll();
    }
    restoreFocus(back);
  };
  if (a === 'export') {
    post({ type: 'export', format: btn.dataset.format as 'markdown' | 'csv' | 'json' });
    done(false);
  } else if (a === 'hide' && result) {
    hiddenNames.add(colId(result.columns[+btn.dataset.col!]));
    done(true);
  } else if (a === 'showAll') {
    hiddenNames.clear();
    done(true);
  } else if (a === 'onlyChanged' && result) {
    const changed = new Set<number>();
    for (let i = 0; i < result.n; i++) for (const k of result.chg[i] || []) changed.add(k);
    result.columns.forEach((c, k) => {
      if (!changed.has(k) && !c.key && c.st === 'eq') hiddenNames.add(colId(c));
      else hiddenNames.delete(colId(c));
    });
    done(true);
  } else if (a === 'key' && result) {
    const k = +btn.dataset.col!;
    const name = result.columns[k].name;
    const current = result.keyCols.map((x) => result!.columns[x].name);
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
    keys = next;
    done(false);
    post({ type: 'keys', keys: next });
  } else if (a === 'useKey' && result) {
    keys = [result.columns[+btn.dataset.col!].name];
    done(false);
    post({ type: 'keys', keys });
  } else if (a === 'autoKey') {
    keys = undefined;
    done(false);
    post({ type: 'keys', keys: null });
  } else if (a === 'ignore' && result) {
    done(false);
    post({ type: 'ignore', columns: [...sessionIgnores(), result.columns[+btn.dataset.col!].name] });
  } else if (a === 'filterCol' && result) {
    filters.column = colId(result.columns[+btn.dataset.col!]);
    done(true);
  } else if (a === 'clearFilters') {
    filters.status.clear();
    filters.column = undefined;
    filters.onlyHits = false;
    $('find-only').setAttribute('aria-pressed', 'false');
    // Its own button goes away with the filters: back to the grid.
    closeMenu();
    rebuildVis();
    renderAll();
    gridEl.focus();
  } else if (a === 'searchCol') {
    query.column = +btn.dataset.col!;
    closeMenu();
    openFind();
    $<HTMLSelectElement>('find-col').value = String(query.column);
    runSearch();
  }
}

// --- menus ------------------------------------------------------------------------------
// Small popups (#menu, role dialog) with buttons, checkboxes and a select: arrow keys
// move between them, Escape or leaving them closes the popup.

const menuItems = () => [...$('menu').querySelectorAll<HTMLElement>('button:not(:disabled), input, select')];

function openMenu(anchor: HTMLElement, label: string, html: string) {
  const m = $('menu');
  m.innerHTML = html;
  m.setAttribute('aria-label', label);
  m.hidden = false;
  const a = anchor.getBoundingClientRect();
  m.style.top = `${a.bottom + 2}px`;
  m.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - m.offsetWidth - 8))}px`;
  menuOpenFor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  (menuItems()[0] ?? m).focus();
}

function closeMenu() {
  const m = $('menu');
  m.hidden = true;
  m.innerHTML = '';
  menuOpenFor?.setAttribute('aria-expanded', 'false');
  menuOpenFor = undefined;
}

$('menu').addEventListener('keydown', (e) => {
  const items = menuItems();
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  // A select keeps its own arrow keys.
  if (document.activeElement instanceof HTMLSelectElement && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
  let to = -1;
  if (e.key === 'ArrowDown') to = (at + 1) % items.length;
  else if (e.key === 'ArrowUp') to = (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = items.length - 1;
  if (to < 0) return;
  e.preventDefault();
  e.stopPropagation();
  items[to].focus();
});

$('menu').addEventListener('focusout', (e) => {
  const next = e.relatedTarget as Node | null;
  // Tabbing out of the popup (or out of the page) closes it; clicks are handled elsewhere.
  if (!menuOpenFor || (next && ($('menu').contains(next) || next === menuOpenFor))) return;
  if (!next) {
    // Focus left the webview, or the focused item was removed: close only in the first case.
    setTimeout(() => {
      if (menuOpenFor && !$('menu').contains(document.activeElement) && document.activeElement !== menuOpenFor) closeMenu();
    }, 0);
    return;
  }
  closeMenu();
});

function openColumnMenu(btn: HTMLElement, k: number) {
  if (!result) return;
  if (menuOpenFor === btn) return closeMenu();
  const c = result.columns[k];
  const isKey = !!c.key;
  const shared = c.li >= 0 && c.ri >= 0;
  openMenu(
    btn,
    `${c.name} column`,
    `<div class="menu-title">${esc(c.name)}${c.from !== undefined ? ` <span class="muted">(was ${esc(c.from)})</span>` : ''}</div>
    <button data-act="hide" data-col="${k}">${icon('eye-closed')} Hide column</button>
    <button data-act="filterCol" data-col="${k}"${shared ? '' : ' disabled'}>${icon('filter')} Only rows changed here</button>
    <button data-act="searchCol" data-col="${k}">${icon('search')} Find in this column…</button>
    ${shared && !c.ignored && !isKey ? `<button data-act="useKey" data-col="${k}">${icon('key')} Use as key</button>` : ''}
    ${shared && !c.ignored && (isKey || result.keyCols.length) ? `<button data-act="key" data-col="${k}">${icon(isKey ? 'close' : 'add')} ${isKey ? 'Remove from key' : 'Add to key'}</button>` : ''}
    ${shared && !c.ignored ? `<button data-act="ignore" data-col="${k}">${icon('eye')} Ignore differences here</button>` : ''}`,
  );
}

$('filter').onclick = () => {
  const btn = $('filter');
  if (menuOpenFor === btn) return closeMenu();
  if (!result) return;
  const fc = filterColumn();
  const box = (st: number, label: string) => `<label><input type="checkbox" data-status="${st}"${filters.status.has(st) ? ' checked' : ''}> ${label}</label>`;
  openMenu(
    btn,
    'Filter rows',
    `<div class="menu-title">Show rows</div>
    ${box(ADD, 'Added')}${box(DEL, 'Removed')}${box(CHG, 'Changed')}${box(MV, 'Moved')}
    <div class="menu-title">Changed in column</div>
    <select id="filter-col" aria-label="Changed in column"><option value="-1">Any column</option>${result.columns
      .slice(0, MAX_LIST)
      .map((c, k) => `<option value="${k}"${fc === k ? ' selected' : ''}>${esc(c.name)}</option>`)
      .join('')}</select>
    <button data-act="clearFilters">${icon('clear-all')} Clear filters</button>`,
  );
};

$('columns').onclick = () => {
  const btn = $('columns');
  if (menuOpenFor === btn) return closeMenu();
  if (!result) return;
  const more = result.columns.length - MAX_LIST;
  openMenu(
    btn,
    'Columns',
    `<div class="menu-title">Columns</div>
    <div class="menu-list">${result.columns
      .slice(0, MAX_LIST)
      .map((c, k) => `<label><input type="checkbox" data-col="${k}"${hiddenNames.has(colId(c)) ? '' : ' checked'}> ${esc(c.name)}${c.st === 'ren' ? ` <span class="muted">(was ${esc(c.from!)})</span>` : ''}</label>`)
      .join('')}${more > 0 ? `<div class="muted">and ${more.toLocaleString()} more</div>` : ''}</div>
    <button data-act="onlyChanged">${icon('diff')} Only changed and key columns</button>
    <button data-act="showAll">${icon('eye')} Show all</button>`,
  );
};

$('export').onclick = () => {
  const btn = $('export');
  if (menuOpenFor === btn) return closeMenu();
  openMenu(
    btn,
    'Export',
    `<button data-act="export" data-format="markdown">${icon('markdown')} Copy as Markdown</button>
    <button data-act="export" data-format="csv">${icon('save-as')} Save highlighter CSV (daff style)…</button>
    <button data-act="export" data-format="json">${icon('json')} Save as JSON…</button>`,
  );
};

$('next').onclick = () => go(cur + 1);
$('prev').onclick = () => go(cur < 0 ? -1 : cur - 1);
$('swap').onclick = () => {
  hiddenNames.clear();
  post({ type: 'swap' });
};
$('edit').onclick = () => setEditing(!editing);

document.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
  btn.onclick = () => {
    if (!opts) return;
    const opt = btn.dataset.opt as Toggle;
    opts[opt] = !opts[opt];
    syncToggles();
    post({ type: 'options', options: { [opt]: opts[opt] } });
    if (opt === 'changesOnly') {
      rebuildVis();
      render();
    }
  };
});

function setView(view: ViewOptions['view']) {
  if (!opts || opts.view === view) return;
  opts.view = view;
  post({ type: 'options', options: { view } });
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  sel.c = 0;
  render();
}

function syncToggles() {
  document.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
    const on = !!opts?.[btn.dataset.opt as Toggle];
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === opts?.view)));
}

function setEditing(on: boolean) {
  editing = on;
  $('editors').hidden = !on;
  $('edit').classList.toggle('on', on);
  $('edit').setAttribute('aria-pressed', String(on));
  if (on) (sides?.left.editable ? $<HTMLTextAreaElement>('ed-left') : $<HTMLTextAreaElement>('ed-right')).focus();
  renderProblems();
}

for (const side of ['left', 'right'] as const) {
  let timer: ReturnType<typeof setTimeout>;
  const ed = $<HTMLTextAreaElement>(`ed-${side}`);
  ed.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!sides) return;
      sides[side].text = ed.value;
      sides[side].restore.text = ed.value.length <= 2_000_000 ? ed.value : undefined;
      saveState();
      post({ type: 'edit', side, text: ed.value });
    }, 300);
  });
}

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.key === 'Escape' && menuOpenFor) {
    const back = menuOpenFor;
    closeMenu();
    back.focus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFind();
    return;
  }
  if (e.key === 'F3' && hits.length) {
    e.preventDefault();
    goHit(e.shiftKey ? hitIdx - 1 : hitIdx + 1);
    return;
  }
  const typing = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'button');
  if (e.key === 'F7') {
    e.preventDefault();
    go(e.shiftKey ? (cur < 0 ? -1 : cur - 1) : cur + 1);
  } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'n' || e.key === 'j') go(cur + 1);
    else if (e.key === 'p' || e.key === 'k') go(cur < 0 ? -1 : cur - 1);
  }
});

// --- find ------------------------------------------------------------------------------

function runSearch() {
  if (!query.text.trim() || !result) {
    hits = [];
    hitSet = new Set();
    hitIdx = -1;
    searchError = undefined;
    capped = false;
    renderFindCount();
    rebuildVis();
    render();
    return;
  }
  const id = ++searchSeq;
  post({ type: 'search', gen, id, query: { ...query } });
}

function onSearch(rows: number[], isCapped: boolean, error: string | undefined, sid: number | undefined) {
  marksSid = sid;
  failedQuery = error ? JSON.stringify(query) : undefined;
  hits = rows;
  hitSet = new Set(rows);
  searchError = error;
  capped = isCapped;
  hitIdx = hits.length ? 0 : -1;
  if (filters.onlyHits) rebuildVis();
  render();
  renderFindCount();
  if (hitIdx >= 0) goHit(0);
}

function renderFindCount() {
  const el = $('find-count');
  $('find-q').classList.toggle('bad', !!searchError || (!!query.text.trim() && !hits.length));
  if (searchError) el.textContent = searchError;
  else if (!query.text.trim()) el.textContent = '';
  else if (!hits.length) el.textContent = 'No results';
  else el.textContent = `${hitIdx >= 0 ? hitIdx + 1 : '?'} of ${hits.length}${capped ? '+' : ''} rows`;
  $<HTMLButtonElement>('find-prev').disabled = $<HTMLButtonElement>('find-next').disabled = !hits.length;
}

function goHit(i: number) {
  if (!hits.length) return;
  hitIdx = (i + hits.length) % hits.length;
  const row = hits[hitIdx];
  let v = vis.indexOf(row);
  if (v < 0) {
    // Hidden by a filter: the match is in the data, not on screen.
    $('announce').textContent = `Match ${hitIdx + 1} of ${hits.length} is in a row hidden by the current filters`;
    renderFindCount();
    return;
  }
  select(v, sel.c < 0 ? 0 : sel.c, true);
  renderFindCount();
  $('announce').textContent = `Match ${hitIdx + 1} of ${hits.length}`;
}

function openFind() {
  $('find').hidden = false;
  const q = $<HTMLInputElement>('find-q');
  q.focus();
  q.select();
}

function closeFind() {
  $('find').hidden = true;
  query.text = '';
  $<HTMLInputElement>('find-q').value = '';
  filters.onlyHits = false;
  $('find-only').setAttribute('aria-pressed', 'false');
  runSearch();
  gridEl.focus();
}

{
  let timer: ReturnType<typeof setTimeout>;
  const q = $<HTMLInputElement>('find-q');
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      query.text = q.value;
      runSearch();
    }, 200);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goHit(e.shiftKey ? hitIdx - 1 : hitIdx + 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  const toggleOpt = (id: string, key: 'caseSensitive' | 'regex') => {
    $(id).onclick = () => {
      query[key] = !query[key];
      $(id).setAttribute('aria-pressed', String(query[key]));
      runSearch();
    };
  };
  toggleOpt('find-case', 'caseSensitive');
  toggleOpt('find-re', 'regex');
  $('find-only').onclick = () => {
    filters.onlyHits = !filters.onlyHits;
    $('find-only').setAttribute('aria-pressed', String(filters.onlyHits));
    rebuildVis();
    render();
  };
  $('find-next').onclick = () => goHit(hitIdx + 1);
  $('find-prev').onclick = () => goHit(hitIdx < 0 ? -1 : hitIdx - 1);
  $('find-close').onclick = () => closeFind();
  $('openFind').onclick = () => openFind();
}

// --- host messages ---------------------------------------------------------------------

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'init') {
    opts = m.options;
    setSide('left', m.left);
    setSide('right', m.right);
    syncToggles();
    const editable = m.left.editable || m.right.editable;
    $('edit').hidden = !editable;
    for (const side of ['left', 'right'] as const) $(`ed-${side}`).parentElement!.hidden = !m[side].editable;
    if (editable && !(m.left.text ?? '').trim() && !(m.right.text ?? '').trim()) setEditing(true);
    render();
  } else if (m.type === 'side') {
    setSide(m.side, m.data);
    const editable = sides!.left.editable || sides!.right.editable;
    $('edit').hidden = !editable;
    for (const side of ['left', 'right'] as const) $(`ed-${side}`).parentElement!.hidden = !sides![side].editable;
    if (!editable) setEditing(false);
    render();
  } else if (m.type === 'options') {
    // The host holds the switches flipped here too, so this is the whole truth.
    opts = m.options;
    syncToggles();
    rebuildVis();
    render();
  } else if (m.type === 'busy') {
    busy = m.what;
    renderStats();
    renderProblems();
  } else if (m.type === 'result') {
    busy = undefined;
    failure = undefined;
    gen = m.gen;
    // For tests and bug reports: which comparison the view shows.
    document.body.dataset.gen = String(gen);
    keys = m.keys;
    const first = !result;
    // A paste box still empty: show how to fill it rather than an empty comparison.
    if ((['left', 'right'] as const).some((side) => m.result.sides[side].empty && sides?.[side].editable)) {
      result = undefined;
      vis = [];
      chRows = [];
      render();
      return;
    }
    result = m.result;
    lines = m.lines;
    windows.clear();
    inflight.clear();
    measured = false;
    const changed = new Set<number>();
    for (let i = 0; i < result.n; i++) for (const k of result.chg[i] || []) changed.add(k);
    widths = measure(result.columns, undefined, changed);
    rebuildVis();
    if (first) sel.v = -1;
    else if (sel.v >= vis.length) sel.v = -1;
    saveState();
    render();
    if (query.text.trim() && JSON.stringify(query) !== failedQuery) runSearch();
    request(0);
  } else if (m.type === 'failure') {
    busy = undefined;
    gen = m.gen;
    result = undefined;
    failure = m.message;
    vis = [];
    chRows = [];
    render();
  } else if (m.type === 'window') {
    if (m.gen !== gen || !result) return;
    const k = Math.floor(m.window.from / CHUNK);
    // Answered for another set of columns than the one shown now: ask again.
    if (String(m.window.cols) !== String(windowCols)) {
      inflight.delete(k);
      scheduleRows();
      return;
    }
    inflight.delete(k);
    const full = spread(m.window, result.columns.length);
    windows.set(k, full);
    if (!measured && k === 0) {
      measured = true;
      const changed = new Set<number>();
      for (let i = 0; i < result.n; i++) for (const k of result.chg[i] || []) changed.add(k);
      widths = measure(result.columns, full, changed);
      gridEl.style.setProperty('--cols', tracks(ctx()!, widths));
    }
    renderRows(true);
    renderStatus();
  } else if (m.type === 'search') {
    if (m.gen !== gen || m.id !== searchSeq) return;
    onSearch(m.rows, m.capped, m.error, m.sid);
  }
});

post({ type: 'ready' });
