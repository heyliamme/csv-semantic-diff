// Bytes to text the way VS Code would read them: a byte order mark first, then the
// encoding from `files.encoding`. Used for big files read in the worker and for Git
// revisions read with the git command.

/** VS Code's encoding ids that WHATWG (TextDecoder) knows under another label. */
const LABELS: Record<string, string> = {
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  cp1252: 'windows-1252',
  macroman: 'macintosh',
  cp866: 'ibm866',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  koi8ru: 'koi8-ru',
  shiftjis: 'shift_jis',
  eucjp: 'euc-jp',
  euckr: 'euc-kr',
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gb18030',
  cp950: 'big5',
  big5hkscs: 'big5',
  windows874: 'windows-874',
  tis620: 'windows-874',
};

/** VS Code's encoding id as a TextDecoder label: undefined for UTF-8, null when there is none. */
export function encodingLabel(id: string | undefined): string | undefined | null {
  if (!id) return undefined;
  const e = id.toLowerCase().replace(/[-_ ]/g, '');
  if (e === 'utf8' || e === 'utf8bom') return undefined;
  let label = LABELS[e];
  if (!label) {
    const win = /^windows(\d+)$/.exec(e);
    const iso = /^iso8859(\d+)$/.exec(e);
    label = win ? `windows-${win[1]}` : iso ? `iso-8859-${iso[1]}` : id;
  }
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return null;
  }
}

/** The text, and a warning when the encoding asked for can't be decoded here (read as UTF-8). */
export function decodeText(buf: Uint8Array, encoding?: string): { text: string; warning?: string } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: b.toString('utf8', 3) };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: b.toString('utf16le', 2) };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: Buffer.from(b.subarray(2)).swap16().toString('utf16le') };
  const label = encodingLabel(encoding);
  if (label) return { text: new TextDecoder(label).decode(b) };
  if (label === null) return { text: b.toString('utf8'), warning: `The encoding ${encoding} (files.encoding) can't be read here; the file was read as UTF-8.` };
  return { text: b.toString('utf8') };
}

export function decode(buf: Uint8Array, encoding?: string): string {
  return decodeText(buf, encoding).text;
}
