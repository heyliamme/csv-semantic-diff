import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { Delimiter } from './core/parse';
import type { ResultView, SearchQuery, Side, SideInfo, Window } from './core/session';
import { Engine, Superseded } from './engine';
import { readRevision } from './git';
import type { FromWebview, Restore, SideData, ToWebview, ViewOptions } from './protocol';

/** Where one side's table comes from. */
export interface Source {
  label: string;
  detail?: string;
  /** The text, unless it is a large file the worker reads itself. */
  text?: string;
  /** A file on disk the worker reads itself (large files). */
  path?: string;
  /** Set when the text lives in a document: enables go-to-line and live updates. */
  uri?: vscode.Uri;
  /** Line in the document where `text` starts (0 unless it's a selection). */
  lineOffset?: number;
  /** Follow edits to the document. Off for selections and fixed revisions. */
  live?: boolean;
  /** This side is `uri` as of a git revision (re-read after a reload). */
  ref?: string;
  delimiter?: Delimiter | 'auto';
  header?: boolean | 'auto';
  /** How the worker decodes `path` (a VS Code encoding id from `files.encoding`). */
  encoding?: string;
}

/** Files above this are read by the worker from disk and never held in the extension host. */
export const BIG_FILE = 8 * 1024 * 1024;
/** Text above this is not kept in the webview's edit box or its saved state. */
const EDITABLE = 2 * 1024 * 1024;
const CHUNK = 100;
/** A search that runs longer than this is stopped (a regular expression that backtracks without end). */
const SEARCH_TIMEOUT = 8000;

const CONFIG = 'csvSemanticDiff';
const EXT_HINT: Record<string, Delimiter> = { tsv: '\t', tab: '\t', psv: '|', csv: ',' };

export function delimiterHint(name: string | undefined): Delimiter | undefined {
  const ext = name?.split('.').pop()?.toLowerCase();
  return ext ? EXT_HINT[ext] : undefined;
}

/** `orders*.csv` against a file name. */
function fileMatches(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(name);
}

/** The file a side's settings come from: a git: revision counts as its working file. */
function settingsUri(u: vscode.Uri | undefined): vscode.Uri | undefined {
  if (!u || u.scheme === 'untitled') return undefined;
  return u.scheme === 'git' ? u.with({ scheme: 'file', query: '' }) : u;
}

/** Settings as they apply to `resource`: folder settings in a multi-root workspace count. */
export function readOptions(resource?: vscode.Uri): ViewOptions {
  const fileName = resource?.path.split('/').pop();
  const c = vscode.workspace.getConfiguration(CONFIG, resource);
  // Settings files can hold anything; keep only values of the right type.
  const strings = (key: string, fallback: string[]) => {
    const v = c.get<unknown>(key);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const v = c.get<unknown>(key);
    return typeof v === 'boolean' ? v : fallback;
  };
  const view = c.get<unknown>('view');
  const byFile = c.get<unknown>('keysByFile');
  let fileKeys: string[] | undefined;
  let fileKeysPattern: string | undefined;
  if (fileName && byFile && typeof byFile === 'object') {
    for (const [pattern, keys] of Object.entries(byFile as Record<string, unknown>)) {
      if (Array.isArray(keys) && keys.every((k) => typeof k === 'string') && fileMatches(pattern, fileName)) {
        fileKeys = keys as string[];
        fileKeysPattern = pattern;
        break;
      }
    }
  }
  return {
    keyColumns: strings('keyColumns', ['id', 'ID', '_id', 'uuid', 'key', 'code', 'sku', 'email', 'name']),
    ignoreColumns: strings('ignoreColumns', []),
    normalizeNumbers: bool('normalizeNumbers', true),
    thousandsSeparators: bool('thousandsSeparators', false),
    trimWhitespace: bool('trimWhitespace', true),
    ignoreCase: bool('ignoreCase', false),
    emptyEqualsMissing: bool('emptyEqualsMissing', true),
    ignoreRowOrder: bool('ignoreRowOrder', false),
    changesOnly: bool('changesOnly', false),
    view: view === 'sideBySide' ? 'sideBySide' : 'unified',
    restricted: !vscode.workspace.isTrusted,
    fileKeys,
    fileKeysPattern,
  };
}

export class DiffPanel {
  private panel: vscode.WebviewPanel;
  private sides: Record<Side, Source>;
  private disposables: vscode.Disposable[] = [];
  /** Per source, the pending reload after a document edit. */
  private timers = new Map<Source, ReturnType<typeof setTimeout>>();
  /** Per source, its file watcher. */
  private watchers = new Map<Source, vscode.Disposable>();
  private disposed = false;
  private engine: Engine;
  /** Bumped on every recompute; the view drops answers from older generations. */
  private gen = 0;
  private loaded: Record<Side, boolean> = { left: false, right: false };
  /** Bumped whenever a side's input changes, so a load that was overtaken isn't marked done. */
  private version: Record<Side, number> = { left: 0, right: 0 };
  private versions = 0;
  /** The worker generation the loaded sides live in. */
  private engineGen = -1;
  /** Options switched in this view, which settings changes leave alone. */
  private touched = new Set<keyof ViewOptions>();
  private result?: ResultView;
  private lines: Record<Side, number[]> = { left: [], right: [] };
  /** Options as the view currently has them (settings plus toggles flipped in the view). */
  private options: ViewOptions;
  /** Key columns chosen in this view; undefined = decided automatically. */
  private keys?: string[];
  private sessionIgnores: string[] = [];
  private computing?: Promise<void>;
  private again = false;

  static open(extensionUri: vscode.Uri, left: Source, right: Source) {
    return new DiffPanel(extensionUri, left, right);
  }

  /** Reopens a comparison after a window reload, re-reading sides that live in files. */
  static async revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, state: unknown) {
    const saved = (state ?? {}) as { left?: Restore; right?: Restore; keys?: string[] };
    const side = async (r: Restore | undefined, fallback: string): Promise<Source> => {
      if (!r) return { label: fallback, text: '' };
      const uri = r.uri ? vscode.Uri.parse(r.uri) : undefined;
      const lost: Source = { label: `${r.label} (couldn't reopen)`, detail: r.detail, text: '' };
      const opts = { delimiter: r.delimiter, header: r.header };
      try {
        // A large selection kept no text: re-reading the file would compare the whole of it.
        if (r.text === undefined && r.lineOffset !== undefined && !r.live && r.ref === undefined) return lost;
        if (r.text !== undefined) return { label: r.label, detail: r.detail, text: r.text, uri, lineOffset: r.lineOffset, live: false, ...opts };
        if (uri && r.ref !== undefined) return { label: r.label, detail: r.detail, text: await readRevision(uri, r.ref, r.label, true), uri, ref: r.ref, live: false, ...opts };
        if (uri) {
          // A file follows its document again; a fixed revision (git:) is read once.
          const src = await sourceFromUri(uri);
          return r.live ? { ...src, ...opts } : { ...src, label: r.label, detail: r.detail, live: false, ...opts };
        }
      } catch {
        return lost;
      }
      return lost;
    };
    const p = new DiffPanel(extensionUri, await side(saved.left, 'Left'), await side(saved.right, 'Right'), panel);
    if (Array.isArray(saved.keys)) p.keys = saved.keys.filter((k): k is string => typeof k === 'string');
    return p;
  }

  private constructor(
    private extensionUri: vscode.Uri,
    left: Source,
    right: Source,
    existing?: vscode.WebviewPanel,
  ) {
    this.sides = { left, right };
    this.engine = new Engine(vscode.Uri.joinPath(extensionUri, 'dist', 'worker.js').fsPath);
    this.options = readOptions(this.settingsResource());
    const options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    this.panel = existing ?? vscode.window.createWebviewPanel('csvSemanticDiff', this.title(), vscode.ViewColumn.Active, options);
    if (existing) {
      existing.webview.options = options;
      existing.title = this.title();
    }
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m).catch((e) => this.fail(e)), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(CONFIG) && this.onSettings(), null, this.disposables);
    vscode.workspace.onDidGrantWorkspaceTrust(() => this.onSettings(), null, this.disposables);
    for (const side of ['left', 'right'] as const) this.watchFile(this.sides[side]);
  }

  private fail(e: unknown) {
    if (this.disposed || e instanceof Superseded) return;
    vscode.window.showErrorMessage(`CSV Semantic Diff: ${e instanceof Error ? e.message : String(e)}`);
  }

  private title() {
    const { left, right } = this.sides;
    return left.label === right.label ? left.label : `${left.label} ↔ ${right.label}`;
  }

  /** The file settings are read for (and the per-file key matched against): the right side's, else the left's. */
  private settingsResource(): vscode.Uri | undefined {
    return settingsUri(this.sides.right.uri) ?? settingsUri(this.sides.left.uri);
  }

  private fileName(): string | undefined {
    return this.settingsResource()?.path.split('/').pop();
  }

  /** The side a source is on now (sides swap), or undefined once it was replaced. */
  private sideOf(s: Source): Side | undefined {
    return this.sides.left === s ? 'left' : this.sides.right === s ? 'right' : undefined;
  }

  /** A side's input changed: it has to be loaded again. */
  private invalidate(side: Side) {
    this.loaded[side] = false;
    this.version[side] = ++this.versions;
  }

  private data(s: Source): SideData {
    // What can be read back (a file, a git revision) is; anything else keeps its text.
    const readable = (s.uri && (s.live || s.lineOffset === undefined)) || s.ref !== undefined;
    const small = s.text !== undefined && s.text.length <= EDITABLE;
    const restore: Restore = {
      label: s.label,
      detail: s.detail,
      uri: s.uri?.toString(),
      ref: s.ref,
      lineOffset: s.lineOffset,
      live: s.live,
      delimiter: s.delimiter,
      header: s.header,
      text: readable ? undefined : small ? s.text : undefined,
    };
    return {
      label: s.label,
      detail: s.detail,
      // A revision's rows are not where they are in the working file.
      canReveal: !!s.uri && s.ref === undefined,
      editable: !readable && small,
      text: small && !s.uri ? s.text : undefined,
      delimiter: s.delimiter ?? 'auto',
      header: s.header ?? 'auto',
      restore,
    };
  }

  private post(m: ToWebview) {
    if (this.disposed) return;
    this.panel.webview.postMessage(m);
  }

  private onSettings() {
    if (this.disposed) return;
    this.rereadSettings();
    this.recompute();
  }

  /** The settings for the files compared now (their folder's, in a multi-root workspace). */
  private rereadSettings() {
    const next = readOptions(this.settingsResource());
    // Keep what was switched in this view; take the rest from the settings.
    for (const k of this.touched) (next as any)[k] = this.options[k];
    this.options = next;
    this.sessionIgnores = this.sessionIgnores.filter((c) => !next.ignoreColumns.includes(c));
    this.post({ type: 'options', options: this.options });
  }

  private onDocument(doc: vscode.TextDocument) {
    for (const s of [this.sides.left, this.sides.right]) {
      if (!s.live || s.uri?.toString() !== doc.uri.toString()) continue;
      clearTimeout(this.timers.get(s));
      this.timers.set(
        s,
        setTimeout(() => {
          this.timers.delete(s);
          // Looked up when it fires: the sides may have been swapped meanwhile.
          const side = this.sideOf(s);
          if (!side || this.disposed) return;
          s.text = doc.getText();
          s.path = undefined;
          this.invalidate(side);
          this.post({ type: 'side', side, data: this.data(s) });
          this.recompute();
        }, 300),
      );
    }
  }

  /** Files changed on disk by something else (a build, git checkout) while not open. */
  private watchFile(s: Source) {
    if (!s.live || s.uri?.scheme !== 'file' || this.watchers.has(s)) return;
    const uri = s.uri;
    // The folder, filtered by exact name: a file name is not a safe glob (`export[1].csv`).
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), '*'));
    const changed = async (e: vscode.Uri) => {
      if (e.toString() !== uri.toString()) return;
      if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString())) return;
      if (!this.sideOf(s) || this.disposed) return;
      const fresh = await sourceFromUri(uri);
      const side = this.sideOf(s);
      if (!side || this.disposed) return;
      s.text = fresh.text;
      s.path = fresh.path;
      s.encoding = fresh.encoding;
      this.invalidate(side);
      this.post({ type: 'side', side, data: this.data(s) });
      this.recompute();
    };
    w.onDidChange(changed);
    w.onDidCreate(changed);
    this.watchers.set(s, w);
  }

  private unwatch(s: Source) {
    this.watchers.get(s)?.dispose();
    this.watchers.delete(s);
    clearTimeout(this.timers.get(s));
    this.timers.delete(s);
  }

  /** Loads what isn't loaded and compares; a request that arrives meanwhile runs once more after. */
  private recompute() {
    if (this.disposed) return;
    if (this.computing) {
      this.again = true;
      return;
    }
    this.computing = this.compute().finally(() => {
      this.computing = undefined;
      if (this.again && !this.disposed) {
        this.again = false;
        this.recompute();
      }
    });
  }

  private async compute() {
    const gen = ++this.gen;
    try {
      // A new worker (the last one died or was stopped) holds no tables.
      const g = this.engine.ensure();
      if (g !== this.engineGen) {
        this.loaded = { left: false, right: false };
        this.engineGen = g;
      }
      const big = Object.values(this.sides).some((s) => s.path || (s.text?.length ?? 0) > 1_000_000);
      if (big) this.post({ type: 'busy', what: 'Comparing…' });
      for (const side of ['left', 'right'] as const) {
        if (this.loaded[side]) continue;
        const s = this.sides[side];
        const v = this.version[side];
        await this.engine.call({
          op: 'load',
          side,
          label: s.label,
          input: {
            text: s.path ? undefined : s.text ?? '',
            path: s.path,
            encoding: s.path ? s.encoding : undefined,
            delimiter: s.delimiter ?? 'auto',
            // From the file name, not the label: `data.tsv (HEAD)` is still a TSV.
            hint: delimiterHint(s.uri?.path ?? s.path ?? s.label),
            header: s.header ?? 'auto',
          },
        });
        // Changed while it loaded: the queued run loads it again.
        if (this.version[side] === v && this.engine.generation === g) this.loaded[side] = true;
      }
      if (!this.loaded.left || !this.loaded.right) {
        this.again = true;
        return;
      }
      const o = this.options;
      const result = await this.engine.call<ResultView>({
        op: 'compare',
        options: {
          keyColumns: o.keyColumns,
          keys: this.keys,
          fileKeys: o.fileKeys,
          ignoreColumns: [...o.ignoreColumns, ...this.sessionIgnores],
          normalizeNumbers: o.normalizeNumbers,
          thousandsSeparators: o.thousandsSeparators,
          trimWhitespace: o.trimWhitespace,
          ignoreCase: o.ignoreCase,
          emptyEqualsMissing: o.emptyEqualsMissing,
          ignoreRowOrder: o.ignoreRowOrder,
        },
        texts: { left: !!(this.sides.left.path || this.sides.left.text?.trim()), right: !!(this.sides.right.path || this.sides.right.text?.trim()) },
      });
      if (gen !== this.gen || this.disposed) return;
      // Row lines as compared (both sides agree on the header only now).
      for (const side of ['left', 'right'] as const) this.lines[side] = await this.engine.call<number[]>({ op: 'lines', side });
      if (gen !== this.gen || this.disposed) return;
      this.result = result;
      this.post({ type: 'result', gen, result, keys: this.keys, lines: this.lines });
    } catch (e) {
      if (gen !== this.gen || this.disposed || e instanceof Superseded) return;
      this.result = undefined;
      this.post({ type: 'failure', gen, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', left: this.data(this.sides.left), right: this.data(this.sides.right), options: this.options });
        this.recompute();
        break;
      case 'window': {
        if (m.gen !== this.gen || !this.result) return;
        const window = await this.engine.call<Window>({ op: 'window', from: m.from, to: m.to, cols: m.cols });
        if (m.gen === this.gen) this.post({ type: 'window', gen: m.gen, window });
        break;
      }
      case 'search': {
        if (m.gen !== this.gen || !this.result) return;
        let r: { rows: number[]; capped: boolean; error?: string; sid?: number };
        try {
          // A pattern that backtracks without end can't be interrupted: the worker is replaced.
          r = await this.engine.call({ op: 'search', query: m.query }, { ms: SEARCH_TIMEOUT, slow: 'The search took too long and was stopped' });
        } catch (e) {
          if (e instanceof Superseded || this.disposed) return;
          this.post({ type: 'search', gen: m.gen, id: m.id, rows: [], capped: false, error: e instanceof Error ? e.message : String(e) });
          this.recompute();
          return;
        }
        if (m.gen === this.gen) this.post({ type: 'search', gen: m.gen, id: m.id, ...r });
        break;
      }
      case 'edit': {
        // Only sides with nothing to read them back from are editable (the view hides the box otherwise).
        const s = this.sides[m.side];
        if (s.uri || s.path) return;
        s.text = m.text;
        this.invalidate(m.side);
        this.recompute();
        break;
      }
      case 'sideOptions': {
        const s = this.sides[m.side];
        s.delimiter = m.delimiter;
        s.header = m.header;
        this.invalidate(m.side);
        this.post({ type: 'side', side: m.side, data: this.data(s) });
        this.recompute();
        break;
      }
      case 'options': {
        // The view keeps its switches here, so a settings change can't undo them.
        const before = JSON.stringify(this.options);
        for (const k of Object.keys(m.options)) this.touched.add(k as keyof ViewOptions);
        Object.assign(this.options, m.options);
        const affects = Object.keys(m.options).some((k) => k !== 'changesOnly' && k !== 'view');
        if (affects && before !== JSON.stringify(this.options)) this.recompute();
        break;
      }
      case 'keys':
        this.keys = m.keys ?? undefined;
        this.recompute();
        break;
      case 'pickKeys':
        await this.pickKeys();
        break;
      case 'saveKeys':
        await this.saveKeys(m.keys);
        break;
      case 'ignore':
        this.sessionIgnores = [...new Set(m.columns.filter((c) => !this.options.ignoreColumns.includes(c)))];
        this.recompute();
        break;
      case 'saveIgnore':
        await this.saveIgnore(m.columns);
        break;
      case 'export':
        await this.export(m.format);
        break;
      case 'reveal': {
        const s = this.sides[m.side];
        if (!s.uri || s.ref !== undefined) return;
        const line = this.lines[m.side][m.row];
        if (line === undefined) return;
        const open = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === s.uri!.toString());
        const doc = await vscode.workspace.openTextDocument(s.uri);
        const at = Math.max(0, line - 1 + (s.lineOffset ?? 0));
        const range = new vscode.Range(at, 0, at, 0);
        await vscode.window.showTextDocument(doc, { viewColumn: open?.viewColumn ?? vscode.ViewColumn.Beside, selection: range, preserveFocus: false });
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(`$(check) Copied ${m.what}`, 2500);
        break;
      case 'paste': {
        const text = await vscode.env.clipboard.readText();
        this.replace(m.side, { label: 'Clipboard', text });
        break;
      }
      case 'pick': {
        const src = await pickSource(`Choose the ${m.side} side`);
        if (src) this.replace(m.side, src);
        break;
      }
      case 'swap':
        this.sides = { left: this.sides.right, right: this.sides.left };
        this.loaded = { left: this.loaded.right, right: this.loaded.left };
        this.lines = { left: this.lines.right, right: this.lines.left };
        // A load in flight finishes on the wrong side of the swap: have it redone.
        this.version = { left: ++this.versions, right: ++this.versions };
        await this.engine.call({ op: 'swap' });
        this.panel.title = this.title();
        this.post({ type: 'side', side: 'left', data: this.data(this.sides.left) });
        this.post({ type: 'side', side: 'right', data: this.data(this.sides.right) });
        this.recompute();
        break;
    }
  }

  private replace(side: Side, src: Source) {
    if (this.disposed) return;
    const old = this.sides[side];
    this.sides[side] = src;
    if (!this.sideOf(old)) this.unwatch(old);
    this.invalidate(side);
    this.panel.title = this.title();
    this.watchFile(src);
    this.post({ type: 'side', side, data: this.data(src) });
    this.rereadSettings();
    this.recompute();
  }

  /** A multi-select of the columns both sides have; the order picked is the key order. */
  private async pickKeys() {
    const r = this.result;
    if (!r) return;
    type Item = vscode.QuickPickItem & { col?: number; auto?: boolean; none?: boolean };
    const shared = r.columns.map((c, k) => ({ c, k })).filter(({ c }) => c.li >= 0 && c.ri >= 0 && !c.ignored);
    const auto = this.keys === undefined;
    const items: Item[] = [
      { label: '$(sparkle) Automatic', description: auto ? 'in use: the key found for you' : 'go back to the key found for you', auto: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...shared.map(({ c, k }) => ({ label: c.name, description: c.from !== undefined ? `was ${c.from}` : undefined, col: k, picked: c.key })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Key columns',
      placeHolder: 'Automatic, or one column, or several for a composite key. Pick nothing to align rows by content.',
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picked) return;
    // Automatic wins when ticked: the current key's columns start out ticked.
    this.keys = picked.some((i) => i.auto) ? undefined : picked.map((i) => r.columns[i.col!].name);
    this.post({ type: 'options', options: this.options });
    this.recompute();
  }

  private async saveKeys(keys: string[]) {
    const name = this.fileName() ?? '';
    const suggested = name.replace(/\d+/g, '*').replace(/\*+/g, '*') || '*.csv';
    const pattern = await vscode.window.showInputBox({
      title: 'Save key for files like…',
      prompt: `Files whose name matches this pattern will use the key ${keys.map((k) => `"${k}"`).join(' + ')}. * matches anything, ? one character.`,
      value: suggested,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a file name pattern'),
    });
    if (!pattern) return;
    const { c, target, where } = this.saveTarget();
    const held = heldValue(c.inspect<unknown>('keysByFile'), target);
    const current = held && typeof held === 'object' ? { ...(held as Record<string, unknown>) } : {};
    current[pattern.trim()] = keys;
    await c.update('keysByFile', current, target);
    vscode.window.setStatusBarMessage(`$(check) Saved to ${where}: csvSemanticDiff.keysByFile`, 3500);
  }

  /**
   * Where a saved key or ignore list goes: the folder of the compared file in a
   * multi-root workspace, the workspace, or the user settings. In Restricted Mode the
   * workspace's values are not applied, so it goes to the user settings.
   */
  private saveTarget() {
    const resource = this.settingsResource();
    const c = vscode.workspace.getConfiguration(CONFIG, resource);
    const folder = resource && vscode.workspace.getWorkspaceFolder(resource);
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length)
      return { c, target: vscode.ConfigurationTarget.Global, where: vscode.workspace.isTrusted ? 'user settings' : 'user settings (Restricted Mode ignores workspace settings)' };
    if (folder && vscode.workspace.workspaceFile) return { c, target: vscode.ConfigurationTarget.WorkspaceFolder, where: `folder settings (${folder.name})` };
    return { c, target: vscode.ConfigurationTarget.Workspace, where: 'workspace settings' };
  }

  private async saveIgnore(columns: string[]) {
    const { c, target, where } = this.saveTarget();
    const held = heldValue(c.inspect<unknown>('ignoreColumns'), target);
    const current = Array.isArray(held) ? held.filter((x): x is string => typeof x === 'string') : [];
    await c.update('ignoreColumns', [...new Set([...current, ...columns])], target);
    vscode.window.setStatusBarMessage(`$(check) Saved to ${where}: csvSemanticDiff.ignoreColumns`, 3500);
  }

  private async export(format: 'markdown' | 'csv' | 'json') {
    if (!this.result) return;
    const text = await this.engine.call<string>({ op: 'export', format, limit: format === 'markdown' ? 500 : undefined });
    if (format === 'markdown') {
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage('$(check) Copied the comparison as Markdown', 2500);
      return;
    }
    const base = this.sides.right.label.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'comparison';
    const ext = format === 'csv' ? 'csv' : 'json';
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      title: format === 'csv' ? 'Save the highlighter CSV' : 'Save the comparison as JSON',
      defaultUri: folder ? vscode.Uri.joinPath(folder, `${base}.diff.${ext}`) : undefined,
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const icons = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${icons}">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    for (const d of this.disposables.splice(0)) d.dispose();
    this.engine.dispose();
    this.panel.dispose();
  }
}

function heldValue(info: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined, target: vscode.ConfigurationTarget): unknown {
  if (target === vscode.ConfigurationTarget.WorkspaceFolder) return info?.workspaceFolderValue;
  return target === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue;
}

/**
 * What the file picker leaves out: files.exclude (which an explicit exclude would
 * otherwise replace), node_modules and .git.
 */
function pickerExclude(): string {
  const globs = new Set(['**/node_modules/**', '**/.git/**']);
  const ex = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude') ?? {};
  for (const [g, on] of Object.entries(ex)) {
    if (on !== true || /[{}]/.test(g)) continue;
    globs.add(g);
    if (!g.endsWith('/**')) globs.add(`${g}/**`);
  }
  return `{${[...globs].join(',')}}`;
}

// ---------------------------------------------------------------------------------------

const TABLE_LANGS = new Set(['csv', 'tsv', 'csv (semicolon)', 'csv (pipe)', 'dynamic csv', 'csv (whitespace)', 'csv (tilde)', 'csv (caret)', 'csv (colon)']);
export const TABLE_EXT = /\.(csv|tsv|tab|psv|txt)$/i;

export async function sourceFromUri(uri: vscode.Uri): Promise<Source> {
  if (uri.scheme === 'file') {
    // A large file is read by the worker straight from disk: never a document, never copied.
    try {
      const st = await vscode.workspace.fs.stat(uri);
      const open = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
      if (st.size > BIG_FILE && !open) {
        // Decoded by the worker as VS Code would: the files.encoding that applies to it.
        const encoding = vscode.workspace.getConfiguration('files', uri).get<string>('encoding');
        return { label: uri.path.split('/').pop()!, detail: vscode.workspace.asRelativePath(uri), path: uri.fsPath, uri, live: true, encoding };
      }
    } catch {
      /* let opening it report the problem */
    }
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  return sourceFromDocument(doc);
}

export function sourceFromDocument(doc: vscode.TextDocument): Source {
  return {
    label: doc.isUntitled ? doc.uri.path : doc.uri.path.split('/').pop()!,
    detail: doc.isUntitled ? undefined : vscode.workspace.asRelativePath(doc.uri),
    text: doc.getText(),
    uri: doc.uri,
    live: true,
  };
}

/** The selection when there is one, else the whole document. */
export function sourceFromEditor(editor: vscode.TextEditor): Source {
  const sel = editor.selection;
  const base = sourceFromDocument(editor.document);
  const doc = editor.document;
  const all = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
  if (sel.isEmpty || sel.contains(all)) return base;
  const start = sel.start.line + 1;
  // A selection that ends at the start of a line (Ctrl+L, Shift+Down) doesn't include it.
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const text = editor.document.getText(new vscode.Range(sel.start.line, 0, end, 0)) || editor.document.getText(sel);
  return {
    ...base,
    label: `${base.label} (selection)`,
    detail: `${base.detail ?? base.label}, ${start === end ? `line ${start}` : `lines ${start}–${end}`}`,
    text,
    lineOffset: sel.start.line,
    live: false,
  };
}

export async function pickSource(title: string, exclude?: vscode.Uri): Promise<Source | undefined> {
  type Item = vscode.QuickPickItem & { run?: () => Promise<Source | undefined> | Source | undefined };
  const isTable = (d: vscode.TextDocument) => TABLE_LANGS.has(d.languageId) || TABLE_EXT.test(d.uri.path);
  // Documents in open tabs only: textDocuments also holds files other extensions loaded.
  const inTabs = new Set<string>();
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (t.input instanceof vscode.TabInputText) inTabs.add(t.input.uri.toString());
  const docs = vscode.workspace.textDocuments.filter(
    (d) => inTabs.has(d.uri.toString()) && isTable(d) && !['output', 'vscode-userdata'].includes(d.uri.scheme) && d.uri.toString() !== exclude?.toString(),
  );
  const name = (u: vscode.Uri) => u.path.split('/').pop()!;
  const where = (u: vscode.Uri) => {
    const rel = vscode.workspace.asRelativePath(u);
    return rel === name(u) ? undefined : rel;
  };
  const clip = (await vscode.env.clipboard.readText()).replace(/\s+/g, ' ').trim();
  const items: Item[] = [];
  if (docs.length) items.push({ label: 'Open editors', kind: vscode.QuickPickItemKind.Separator });
  for (const d of docs)
    items.push({
      label: `$(table) ${d.isUntitled ? d.uri.path : name(d.uri)}`,
      description: d.isUntitled ? 'unsaved' : where(d.uri),
      run: () => sourceFromDocument(d),
    });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(clippy) Clipboard', description: clip ? (clip.length > 60 ? clip.slice(0, 59) + '…' : clip) : 'empty', run: async () => ({ label: 'Clipboard', text: await vscode.env.clipboard.readText() }) },
    {
      label: '$(folder-opened) Browse…',
      run: async () => {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV and TSV': ['csv', 'tsv', 'tab', 'psv', 'txt'], 'All files': ['*'] } });
        return picked?.[0] ? sourceFromUri(picked[0]) : undefined;
      },
    },
    { label: '$(new-file) Empty (paste or type)', run: () => ({ label: 'Untitled', text: '' }) },
  );
  // Table files in the workspace that aren't open.
  if (vscode.workspace.workspaceFolders?.length) {
    const open = new Set(docs.map((d) => d.uri.toString()));
    const found = await vscode.workspace.findFiles('**/*.{csv,tsv,tab,psv}', pickerExclude(), 200);
    const files = found.filter((u) => !open.has(u.toString()) && u.toString() !== exclude?.toString()).sort((a, b) => a.path.localeCompare(b.path));
    if (files.length) items.push({ label: 'Workspace', kind: vscode.QuickPickItemKind.Separator });
    for (const u of files) items.push({ label: `$(file) ${name(u)}`, description: where(u), run: () => sourceFromUri(u) });
  }
  const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'An open file, the clipboard, or a file in the workspace', matchOnDescription: true });
  return pick?.run?.();
}
