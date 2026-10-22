// A CSV/TSV reader for files people actually have: RFC 4180 quoting with "" escapes,
// fields that span lines, CRLF or CR line ends, a byte order mark, rows with too few or
// too many fields, and a delimiter that has to be guessed. It is a single pass over the
// text with charCodeAt, which is what makes 50 MB files take well under a second.

export type Delimiter = ',' | '\t' | ';' | '|';
export const DELIMITERS: Delimiter[] = [',', '\t', ';', '|'];

export interface ParseOptions {
  /** A fixed delimiter, or `auto` to detect one; `hint` breaks ties (from the file extension). */
  delimiter?: Delimiter | 'auto';
  hint?: Delimiter;
  /** Whether the first row names the columns, or `auto` to decide from the content. */
  header?: boolean | 'auto';
}

export interface Table {
  /** Column names: from the header row, or `Column 1`… when there is none. */
  columns: string[];
  /** One array per data row. A short row is a short array: a missing cell reads as undefined. */
  rows: string[][];
  /** 1-based line where each data row starts in the source. */
  lines: number[];
  /** The line of the header row, 0 when there is none. */
  headerLine: number;
  delimiter: Delimiter;
  delimiterAuto: boolean;
  header: boolean;
  headerAuto: boolean;
  warnings: string[];
  /** The widest row, when wider than the header: those cells become extra columns. */
  width: number;
  /** The header row as read (untrimmed), so the decision can be undone. */
  headRow?: string[];
  /** Warnings from reading the text, before the header was decided. */
  readWarnings: string[];
}

const QUOTE = 34;
const CR = 13;
const LF = 10;

/** Delimiter counts per line, outside quotes, over the first lines of the text. */
function countPerLine(text: string, maxLines: number): Map<number, number[]> {
  const counts = new Map<number, number[]>(DELIMITERS.map((d) => [d.charCodeAt(0), []]));
  const cur = new Map<number, number>();
  let lines = 0;
  let inQuotes = false;
  let lineHasText = false;
  const flush = () => {
    if (lineHasText) {
      for (const [code, list] of counts) list.push(cur.get(code) ?? 0);
      lines++;
    }
    cur.clear();
    lineHasText = false;
  };
  for (let i = 0; i < text.length && lines < maxLines; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) inQuotes = !inQuotes;
    else if (!inQuotes && (c === LF || c === CR)) {
      flush();
      if (c === CR && text.charCodeAt(i + 1) === LF) i++;
      continue;
    } else if (!inQuotes && counts.has(c)) cur.set(c, (cur.get(c) ?? 0) + 1);
    if (c !== 32) lineHasText = true;
  }
  if (lines < maxLines) flush();
  return counts;
}

/**
 * The delimiter that splits the first lines into the same number of fields most
 * consistently. A hint (from the file extension) wins when it is nearly as consistent
 * and splits the first line (the header, usually) like the rest: a `.csv` written with
 * semicolons and decimal commas has a comma in every row but the header.
 */
export function detectDelimiter(text: string, hint?: Delimiter): Delimiter {
  const counts = countPerLine(text, 40);
  let best: { d: Delimiter; score: number } | undefined;
  const scores = new Map<Delimiter, number>();
  const headFits = new Map<Delimiter, boolean>();
  for (const d of DELIMITERS) {
    const list = counts.get(d.charCodeAt(0))!;
    if (!list.length) continue;
    const freq = new Map<number, number>();
    for (const n of list) freq.set(n, (freq.get(n) ?? 0) + 1);
    let mode = 0;
    let modeCount = 0;
    for (const [n, k] of freq) if (k > modeCount || (k === modeCount && n > mode)) [mode, modeCount] = [n, k];
    if (mode === 0) continue;
    // Consistency first, then how many fields it yields (more structure is more likely).
    const score = modeCount / list.length + Math.min(mode, 10) / 100;
    scores.set(d, score);
    headFits.set(d, list[0] === mode);
    if (!best || score > best.score) best = { d, score };
  }
  if (hint && scores.has(hint) && best && scores.get(hint)! >= best.score - 0.1 && (headFits.get(hint) || best.d === hint)) return hint;
  return best?.d ?? hint ?? ',';
}

/** Words that name columns far more often than they fill them. */
const COLUMN_WORDS = new Set(
  (
    'id key code sku uuid ref email mail phone name first last full given family nickname username user login title description desc ' +
    'type kind category class status state city town country region province capital address street zip postcode postal location place ' +
    'date time year month day created updated modified deleted value amount price cost qty quantity count total sum unit units currency ' +
    'label tag tags note notes comment comments remark lang language locale word words term translation meaning definition text body subject ' +
    'message url link path file owner author company organisation organization department team group role gender sex age color colour size ' +
    'product item model brand source target start end version score rank level weight height width length latitude longitude lat lon'
  ).split(' '),
);

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_LIKE = /\d{4}-\d{2}|\d{2}\/\d{2}\/\d{2}|\d+:\d{2}|@/;

/** Whether the first row reads as column names rather than data. */
export function looksLikeHeader(rows: string[][]): boolean {
  const head = rows[0];
  if (!head || !head.length) return false;
  // A trailing delimiter on every line: an empty last column that says nothing either way.
  if (head.length >= 2 && head[head.length - 1].trim() === '' && rows.slice(1, 41).every((r) => r.length < head.length || (r[head.length - 1] ?? '').trim() === ''))
    return looksLikeHeader(rows.map((r) => r.slice(0, head.length - 1)));
  // pandas writes the index column with an empty name: judge the other cells.
  if (head.length >= 2 && head[0].trim() === '' && head.slice(1).every((c) => c.trim() !== '')) return looksLikeHeader(rows.map((r) => r.slice(1)));
  if (head.some((c) => c.trim() === '' || NUMERIC.test(c.trim()) || DATE_LIKE.test(c))) return false;
  if (new Set(head.map((c) => c.trim())).size !== head.length) return false;
  if (rows.length === 1) return true;
  // A column that is text in the first row and numbers, dates or codes with digits below is a header.
  const sample = rows.slice(1, 41);
  for (let c = 0; c < head.length; c++) {
    if (/\d/.test(head[c])) continue;
    let numeric = 0;
    let filled = 0;
    for (const r of sample) {
      const v = r[c];
      if (v === undefined || v.trim() === '') continue;
      filled++;
      if (NUMERIC.test(v.trim()) || DATE_LIKE.test(v) || /\d/.test(v)) numeric++;
    }
    if (filled && numeric >= filled * 0.8) return true;
  }
  // All text: a header when its cells look like identifiers (snake_case, camelCase, a
  // digit), or are words columns are usually called (`Name`, `City`) that never appear
  // below, or are all lower-case over rows that are not, or the rows below repeat values.
  const ident = head.every((c) => /^[A-Za-z_][\w .()/#-]*$/.test(c.trim()));
  if (!ident) return false;
  if (head.some((c) => /[_\d]|[a-z][A-Z]/.test(c))) return true;
  const named = head.filter((c) => c.trim().toLowerCase().split(/[^a-z]+/).some((w) => COLUMN_WORDS.has(w))).length;
  if (named * 2 >= head.length && head.every((c, k) => !sample.some((r) => (r[k] ?? '').trim().toLowerCase() === c.trim().toLowerCase()))) return true;
  const below = new Set<string>();
  let total = 0;
  let capitalised = 0;
  for (const r of sample)
    for (const v of r)
      if (v !== undefined && v !== '') {
        total++;
        below.add(v);
        if (/^[A-Z]/.test(v)) capitalised++;
      }
  if (total === 0) return true;
  if (below.size < total * 0.9) return true;
  return head.every((c) => c === c.toLowerCase()) && capitalised > 0;
}

export function parseTable(text: string, options: ParseOptions = {}): Table {
  const warnings: string[] = [];
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const delimiterAuto = !options.delimiter || options.delimiter === 'auto';
  const delimiter: Delimiter = delimiterAuto ? detectDelimiter(text.slice(i, i + 65536), options.hint) : (options.delimiter as Delimiter);
  const D = delimiter.charCodeAt(0);
  const n = text.length;

  const rows: string[][] = [];
  const lines: number[] = [];
  let line = 1;
  let row: string[] = [];
  let rowLine = 1;
  let unterminated = false;
  let strayQuotes = 0;
  /** Whether the row being read has a quoted field: `""` is a value, not a blank. */
  let quoted = false;

  while (i <= n) {
    // One field, starting at i.
    let value: string;
    if (text.charCodeAt(i) === QUOTE) {
      quoted = true;
      // Quoted: "" is a quote; line breaks are part of the value.
      let j = i + 1;
      let out = '';
      let run = j;
      for (;;) {
        if (j >= n) {
          unterminated = true;
          out += text.slice(run, j);
          break;
        }
        const c = text.charCodeAt(j);
        if (c === QUOTE) {
          if (text.charCodeAt(j + 1) === QUOTE) {
            out += text.slice(run, j + 1);
            j += 2;
            run = j;
            continue;
          }
          out += text.slice(run, j);
          j++;
          break;
        }
        if (c === LF) line++;
        else if (c === CR && text.charCodeAt(j + 1) !== LF) line++;
        j++;
      }
      // Text after the closing quote up to the delimiter is kept, as spreadsheets do.
      let k = j;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === D || c === LF || c === CR) break;
        k++;
      }
      if (k > j) {
        out += text.slice(j, k);
        strayQuotes++;
      }
      value = out;
      i = k;
    } else {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === D || c === LF || c === CR) break;
        j++;
      }
      value = text.slice(i, j);
      i = j;
    }
    row.push(value);
    const c = i < n ? text.charCodeAt(i) : -1;
    if (c === D) {
      i++;
      if (i === n) {
        // A trailing delimiter: one more, empty field.
        row.push('');
        i++;
        endRow();
        break;
      }
      continue;
    }
    // End of the row (line break or end of text).
    if (c === CR && text.charCodeAt(i + 1) === LF) i += 2;
    else i++;
    endRow();
    if (c !== -1) line++;
    rowLine = line;
  }

  function endRow() {
    // An empty line is not a record, and neither is a row of empty fields (`,,` is how
    // spreadsheets save a blank row) or of spaces. A quoted empty value (`""`) is one.
    let blank = !quoted;
    quoted = false;
    for (let k = 0; k < row.length && blank; k++) if (row[k] !== '' && row[k].trim() !== '') blank = false;
    if (blank) {
      row = [];
      return;
    }
    rows.push(row);
    lines.push(rowLine);
    row = [];
  }

  if (unterminated) warnings.push('A quoted field is never closed; the rest of the file was read as that field.');
  if (strayQuotes) warnings.push(`${strayQuotes} ${strayQuotes === 1 ? 'field has' : 'fields have'} text after a closing quote, kept as is.`);

  const headerAuto = options.header === undefined || options.header === 'auto';
  const header = headerAuto ? looksLikeHeader(rows) : !!options.header;
  return shape(rows, lines, header, { delimiter, delimiterAuto, headerAuto, readWarnings: warnings });
}

/** Columns, header and the warnings about row widths, from the rows as read. */
function shape(rows: string[][], lines: number[], header: boolean, base: Pick<Table, 'delimiter' | 'delimiterAuto' | 'headerAuto' | 'readWarnings'>): Table {
  const warnings = [...base.readWarnings];
  let columns: string[];
  let headerLine = 0;
  let headRow: string[] | undefined;
  if (header && rows.length) {
    headRow = rows.shift()!;
    columns = headRow.map((c) => c.trim());
    headerLine = lines.shift()!;
  } else columns = [];
  let width = 0;
  for (const r of rows) if (r.length > width) width = r.length;
  // Name the columns a header leaves unnamed, and the extra cells of over-long rows.
  const seen = new Map<string, number>();
  columns = columns.map((c, k) => {
    let name = c === '' ? `Column ${k + 1}` : c;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count) name = `${name} (${count + 1})`;
    return name;
  });
  if (width > columns.length) {
    const extra = width - columns.length;
    if (header) {
      let long = 0;
      for (const r of rows) if (r.length > columns.length) long++;
      warnings.push(`${long} ${long === 1 ? 'row has' : 'rows have'} more fields than the header; the extra ${extra === 1 ? 'field appears as a column' : 'fields appear as columns'} named Column ${columns.length + 1}${extra > 1 ? `–${width}` : ''}.`);
    }
    for (let k = columns.length; k < width; k++) columns.push(`Column ${k + 1}`);
  }
  if (header) {
    let short = 0;
    for (const r of rows) if (r.length < columns.length) short++;
    if (short) warnings.push(`${short} ${short === 1 ? 'row has' : 'rows have'} fewer fields than the header; missing cells read as empty.`);
  }
  return { columns, rows, lines, headerLine, header, warnings, width: Math.max(width, columns.length), headRow, ...base };
}

/** The same table with the first row read as a header, or not. */
export function withHeader(t: Table, header: boolean): Table {
  if (t.header === header) return t;
  const base = { delimiter: t.delimiter, delimiterAuto: t.delimiterAuto, headerAuto: t.headerAuto, readWarnings: t.readWarnings };
  if (header) return shape(t.rows.slice(), t.lines.slice(), true, base);
  if (!t.headRow) return shape(t.rows.slice(), t.lines.slice(), false, base);
  return shape([t.headRow, ...t.rows], [t.headerLine, ...t.lines], false, base);
}

/** Cells that could be column names at all: text, distinct, at most the first one empty. */
function headerShaped(head: string[] | undefined): boolean {
  if (!head || !head.length) return false;
  let cells = head.length >= 2 && head[head.length - 1].trim() === '' ? head.slice(0, -1) : head;
  cells = cells.length >= 2 && cells[0].trim() === '' ? cells.slice(1) : cells;
  if (cells.some((c) => c.trim() === '' || NUMERIC.test(c.trim()) || DATE_LIKE.test(c))) return false;
  return new Set(cells.map((c) => c.trim())).size === cells.length;
}

/**
 * Both sides of a comparison read their first row the same way. A side whose header was
 * set by hand leads a side left on automatic. When both were guessed and the guesses
 * differ (the rows below decide, and they differ), the side without one follows the side
 * with one, provided its first row could be column names too. When neither found one but
 * both first rows hold the same names in another order, those are headers.
 */
export function agreeOnHeader(L: Table, R: Table): [Table, Table] {
  if (!L.headerAuto && !R.headerAuto) return [L, R];
  if (!L.headerAuto || !R.headerAuto) {
    const [fixed, auto] = L.headerAuto ? [R, L] : [L, R];
    if (auto.header === fixed.header) return [L, R];
    const followed = withHeader(auto, fixed.header);
    return L.headerAuto ? [followed, R] : [L, followed];
  }
  if (L.header === R.header) {
    if (L.header || !sameNamesReordered(L.rows[0], R.rows[0])) return [L, R];
    return [withHeader(L, true), withHeader(R, true)];
  }
  const without = L.header ? R : L;
  const first = without.rows[0];
  if (!first || !headerShaped(first)) return [L, R];
  return L.header ? [L, withHeader(R, true)] : [withHeader(L, true), R];
}

/** Two first rows that could both be column names, the same ones in a different order. */
function sameNamesReordered(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length < 2 || a.length !== b.length || !headerShaped(a) || !headerShaped(b)) return false;
  const norm = (r: string[]) => r.map((c) => c.trim().toLowerCase());
  const x = norm(a);
  const y = norm(b);
  const set = new Set(x);
  return y.every((c) => set.has(c)) && x.some((c, k) => c !== y[k]);
}

/** One field written back out: quoted when it needs to be. */
export function quoteField(v: string, delimiter: Delimiter = ','): string {
  return v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r') || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
