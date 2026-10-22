import * as vscode from 'vscode';
import { readRevision, recentCommits, shortRef } from './git';
import { DiffPanel, pickSource, sourceFromDocument, sourceFromEditor, sourceFromUri, type Source } from './panel';

let selected: vscode.Uri | undefined;

export function activate(context: vscode.ExtensionContext) {
  const open = (left: Source, right: Source) => DiffPanel.open(context.extensionUri, left, right);
  const fail = (e: unknown) => vscode.window.showErrorMessage(`CSV Semantic Diff: ${e instanceof Error ? e.message : String(e)}`);
  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        fail(e);
      }
    });

  /** The editor a command acts on: the one it was invoked from, else the active one. */
  const current = async (uri?: vscode.Uri): Promise<Source | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (uri instanceof vscode.Uri && editor?.document.uri.toString() !== uri.toString()) return sourceFromUri(uri);
    if (editor) return sourceFromEditor(editor);
    if (uri instanceof vscode.Uri) return sourceFromUri(uri);
    vscode.window.showInformationMessage('Open a CSV or TSV file first.');
    return undefined;
  };

  const isFile = async (uri: vscode.Uri) => {
    try {
      return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) === 0;
    } catch {
      return true; // let opening it report the problem
    }
  };

  /** The whole file (a revision has nothing that matches a selection) and its name. */
  const wholeFile = async (uri?: vscode.Uri) => {
    const editor = vscode.window.activeTextEditor;
    const target = uri instanceof vscode.Uri ? uri : editor?.document.uri;
    if (!target) {
      vscode.window.showInformationMessage('Open a CSV or TSV file first.');
      return undefined;
    }
    const right = editor?.document.uri.toString() === target.toString() ? sourceFromDocument(editor.document) : await sourceFromUri(target);
    return { target, right, name: target.path.split('/').pop()! };
  };

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('csvSemanticDiff', {
      deserializeWebviewPanel: async (panel, state) => {
        await DiffPanel.revive(context.extensionUri, panel, state);
      },
    }),

    command('csvSemanticDiff.new', () => open({ label: 'Left', text: '' }, { label: 'Right', text: '' })),

    command('csvSemanticDiff.compareSelected', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const files = uris?.length ? uris : uri ? [uri] : [];
      if (files.length !== 2) {
        vscode.window.showInformationMessage('Select exactly two files in the Explorer, then choose “Compare as CSV”.');
        return;
      }
      if (!(await isFile(files[0])) || !(await isFile(files[1]))) {
        vscode.window.showInformationMessage('Select two files, not folders.');
        return;
      }
      open(await sourceFromUri(files[0]), await sourceFromUri(files[1]));
    }),

    command('csvSemanticDiff.selectForCompare', async (uri?: vscode.Uri) => {
      const pick = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!pick) {
        vscode.window.showInformationMessage('Open a CSV file, or right-click one in the Explorer, to select it for comparing.');
        return;
      }
      selected = pick;
      await vscode.commands.executeCommand('setContext', 'csvSemanticDiff.hasSelection', true);
      vscode.window.setStatusBarMessage(`$(check) Selected ${pick.path.split('/').pop()} for CSV compare`, 4000);
    }),

    command('csvSemanticDiff.compareWithSelected', async (uri?: vscode.Uri) => {
      if (!selected) {
        vscode.window.showInformationMessage('Choose “Select for CSV Compare” on a file first.');
        return;
      }
      const right = await current(uri);
      if (!right) return;
      vscode.window.setStatusBarMessage(`Comparing with ${vscode.workspace.asRelativePath(selected)}`, 4000);
      open(await sourceFromUri(selected), right);
    }),

    command('csvSemanticDiff.compareWithClipboard', async (uri?: vscode.Uri) => {
      const left = await current(uri);
      if (!left) return;
      open(left, { label: 'Clipboard', text: await vscode.env.clipboard.readText() });
    }),

    command('csvSemanticDiff.compareWith', async (uri?: vscode.Uri) => {
      const left = await current(uri);
      if (!left) return;
      const right = await pickSource(`Compare ${left.label} with…`, left.uri);
      if (right) open(left, right);
    }),

    command('csvSemanticDiff.compareWithHead', async (uri?: vscode.Uri) => {
      const w = await wholeFile(uri);
      if (!w) return;
      const text = await readRevision(w.target, 'HEAD', w.right.label);
      open({ label: `${w.name} (HEAD)`, detail: `${vscode.workspace.asRelativePath(w.target)} at HEAD`, text, uri: w.target, ref: 'HEAD', live: false }, w.right);
    }),

    command('csvSemanticDiff.compareWithRef', async (uri?: vscode.Uri) => {
      const w = await wholeFile(uri);
      if (!w) return;
      type Item = vscode.QuickPickItem & { ref?: string; ask?: boolean };
      const commits = await recentCommits(w.target);
      const items: Item[] = [
        { label: '$(git-commit) HEAD', description: 'the last commit', ref: 'HEAD' },
        { label: '$(git-commit) HEAD~1', description: 'the commit before', ref: 'HEAD~1' },
        { label: '$(edit) Type a revision…', description: 'a branch, a tag, a commit, main~3', ask: true },
      ];
      if (commits.length) items.push({ label: `Commits that changed ${w.name}`, kind: vscode.QuickPickItemKind.Separator });
      for (const c of commits) items.push({ label: `$(git-commit) ${c.hash.slice(0, 8)}`, description: c.message, detail: [c.when, c.author].filter(Boolean).join(' · ') || undefined, ref: c.hash });
      const pick = await vscode.window.showQuickPick(items, { title: `Compare ${w.name} with a revision`, placeHolder: 'Which revision?', matchOnDescription: true, matchOnDetail: true });
      if (!pick) return;
      let ref = pick.ref;
      if (pick.ask) ref = (await vscode.window.showInputBox({ title: 'Git revision', prompt: 'A branch, a tag, a commit, or an expression such as main~3', value: 'HEAD~1', validateInput: (v) => (v.trim() ? undefined : 'Enter a revision') }))?.trim();
      if (!ref) return;
      const text = await readRevision(w.target, ref, w.right.label);
      open({ label: `${w.name} (${shortRef(ref)})`, detail: `${vscode.workspace.asRelativePath(w.target)} at ${shortRef(ref)}`, text, uri: w.target, ref, live: false }, w.right);
    }),

    command('csvSemanticDiff.fromDiffEditor', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      if (!(input instanceof vscode.TabInputTextDiff)) {
        vscode.window.showInformationMessage('Open a diff editor first, for example a changed CSV file in Source Control.');
        return;
      }
      const [left, right] = await Promise.all([sourceFromUri(input.original), sourceFromUri(input.modified)]);
      const ref = (u: vscode.Uri) => (u.scheme === 'git' ? (JSON.parse(u.query || '{}').ref as string | undefined) : undefined);
      const lr = ref(input.original);
      const rr = ref(input.modified);
      if (lr !== undefined) left.label += ` (${shortRef(lr)})`;
      if (rr !== undefined) right.label += ` (${shortRef(rr)})`;
      // git: documents: show the file's workspace path and which version.
      for (const [s, u, r] of [
        [left, input.original, lr],
        [right, input.modified, rr],
      ] as const)
        if (u.scheme === 'git' && r !== undefined) s.detail = `${vscode.workspace.asRelativePath(u.with({ scheme: 'file', query: '' }))} at ${shortRef(r)}`;
      // Other diffs (Compare with Saved, extensions' own schemes): take the names VS Code shows.
      const shown = tab!.label.split(' ↔ ');
      if (left.label === right.label && shown.length === 2 && shown[0] !== shown[1]) {
        left.label = shown[0];
        right.label = shown[1];
      } else if (left.label === right.label) left.label += ' (original)';
      for (const [s, u] of [
        [left, input.original],
        [right, input.modified],
      ] as const) {
        if (u.scheme !== 'file') s.live = false;
        if (u.scheme !== 'file' && u.scheme !== 'git' && u.scheme !== 'untitled') s.detail = undefined;
      }
      open(left, right);
    }),
  );
}

export function deactivate() {}
