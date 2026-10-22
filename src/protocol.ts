import type { Delimiter } from './core/parse';
import type { ExportFormat, ResultView, SearchQuery, Side, Window } from './core/session';

export type { Side };

export interface SideData {
  label: string;
  /** Second line in the column header: a path, a git ref, "selection, lines 4–20". */
  detail?: string;
  /** The view can open the source at a row. */
  canReveal: boolean;
  /** The side is editable in the view (nothing to read it back from). */
  editable: boolean;
  /** Text to show in the edit box, when the side is small enough to edit. */
  text?: string;
  delimiter: Delimiter | 'auto';
  header: boolean | 'auto';
  /** What the host needs to reopen this side after a window reload. */
  restore: Restore;
}

export interface Restore {
  label: string;
  detail?: string;
  uri?: string;
  /** `ref` of a git revision of `uri`. */
  ref?: string;
  /** Kept for sides that can't be read back from a document. */
  text?: string;
  lineOffset?: number;
  live?: boolean;
  delimiter?: Delimiter | 'auto';
  header?: boolean | 'auto';
}

export interface ViewOptions {
  keyColumns: string[];
  ignoreColumns: string[];
  normalizeNumbers: boolean;
  thousandsSeparators: boolean;
  trimWhitespace: boolean;
  ignoreCase: boolean;
  emptyEqualsMissing: boolean;
  ignoreRowOrder: boolean;
  changesOnly: boolean;
  view: 'unified' | 'sideBySide';
  /** The workspace is untrusted: settings from it were not applied. */
  restricted: boolean;
  /** Key columns from the per-file setting that apply to this comparison. */
  fileKeys?: string[];
  /** The pattern those keys came from. */
  fileKeysPattern?: string;
}

export type ToWebview =
  | { type: 'init'; left: SideData; right: SideData; options: ViewOptions }
  | { type: 'side'; side: Side; data: SideData }
  | { type: 'options'; options: ViewOptions }
  | { type: 'busy'; what: string }
  | { type: 'result'; gen: number; result: ResultView; keys?: string[]; lines: Record<Side, number[]> }
  | { type: 'failure'; gen: number; message: string; side?: Side }
  | { type: 'window'; gen: number; window: Window }
  | { type: 'search'; gen: number; id: number; rows: number[]; capped: boolean; error?: string; sid?: number };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'window'; gen: number; from: number; to: number; cols?: number[] }
  | { type: 'search'; gen: number; id: number; query: SearchQuery }
  | { type: 'edit'; side: Side; text: string }
  | { type: 'sideOptions'; side: Side; delimiter: Delimiter | 'auto'; header: boolean | 'auto' }
  | { type: 'options'; options: Partial<ViewOptions> }
  | { type: 'keys'; keys: string[] | null }
  | { type: 'pickKeys' }
  | { type: 'saveKeys'; keys: string[] }
  /** Sets the columns ignored in this view (on top of the setting). */
  | { type: 'ignore'; columns: string[] }
  | { type: 'saveIgnore'; columns: string[] }
  | { type: 'export'; format: ExportFormat }
  | { type: 'reveal'; side: Side; row: number }
  | { type: 'copy'; text: string; what: string }
  | { type: 'pick'; side: Side }
  | { type: 'paste'; side: Side }
  | { type: 'swap' };
