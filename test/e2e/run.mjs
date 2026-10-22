// End-to-end: installs the packaged extension into a throwaway VS Code profile, opens a
// workspace of sample tables in a fresh git repository, and uses the extension the way
// a person would: shortcuts, menus, quick picks, the clipboard, git, and every control
// in the view. Linux, with `code` on PATH.
//
//   npm run package && node test/e2e/run.mjs [csv-semantic-diff-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'csv-semantic-diff-e2e-')));
const ws = path.join(root, 'workspace');
const out = path.join(root, 'shots');
mkdirSync(ws);
mkdirSync(out);
for (const f of ['customers-v1.csv', 'customers-v2.csv', 'inventory-v1.tsv', 'inventory-v2.tsv']) copyFileSync(path.join('samples', f), path.join(ws, f));
const products = (price, stock, ruler) => `sku,name,price,stock\nA1,Pen,1.50,${stock}\nA2,Pencil,${price},250\nA3,Eraser,0.50,80\n${ruler ? 'A4,Ruler,2.00,40\n' : ''}`;
writeFileSync(path.join(ws, 'products.csv'), products('0.90', 100, false));
writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const git = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
git('init', '-q');
git('add', '.');
git('commit', '-qm', 'samples');
// A second commit (price change, a new row), then a working copy that differs from HEAD in one cell.
writeFileSync(path.join(ws, 'products.csv'), products('0.95', 100, true));
git('commit', '-qam', 'price and ruler');
writeFileSync(path.join(ws, 'products.csv'), products('0.95', 90, true));

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'window.titleBarStyle': 'custom',
  'git.openRepositoryInParentFolders': 'never',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'editor.autoClosingQuotes': 'never',
  'editor.autoClosingBrackets': 'never',
  'editor.formatOnType': false,
  'files.autoSave': 'off',
  'extensions.ignoreRecommendations': true,
};
const vs = new VSCode(root);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
    if (process.env.E2E_STOP_AFTER && name.startsWith(process.env.E2E_STOP_AFTER)) throw new Error('stop');
  } catch (e) {
    if (e.message === 'stop') throw e;
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// In the webview.
const W = {
  stats: `[...document.getElementById('stats').children].map((e) => e.textContent.trim().replace(/\\s+/g, ' ')).join(' ')`,
  pos: `document.getElementById('pos').textContent`,
  heads: `[...document.querySelectorAll('.head .label')].map((e) => e.textContent)`,
  headNotes: (side) => `[...document.querySelectorAll('.head.${side} .note')].map((e) => e.textContent)`,
  key: `document.getElementById('keychip')?.textContent.trim()`,
  keybar: `document.getElementById('keybar').textContent`,
  columns: `[...document.querySelectorAll('#head .hn')].map((e) => e.textContent)`,
  rows: `document.querySelectorAll('#rows .row').length`,
  visible: `document.getElementById('grid').getAttribute('aria-rowcount')`,
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  check: (opt, on) => `(() => { const b = document.querySelector('[data-opt="${opt}"]'); if ((b.getAttribute('aria-pressed') === 'true') !== ${on}) b.click(); return b.getAttribute('aria-pressed'); })()`,
  rowWithText: (text) => `[...document.querySelectorAll('#rows .row')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`,
  cellOf: (rowText, colName) => `(() => { const cols = [...document.querySelectorAll('#head .cell')]; const k = cols.findIndex((c) => c.querySelector('.hn')?.textContent === ${JSON.stringify(colName)}); const r = ${W_rowWithText(rowText)}; return r && r.children[k]; })()`,
  footer: `document.getElementById('status').textContent.replace(/\\s+/g, ' ').trim()`,
  key7: (shift) => `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', shiftKey: ${!!shift}, bubbles: true }))`,
};
function W_rowWithText(text) {
  return `[...document.querySelectorAll('#rows .row')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
}
let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });
const gridKey = (k, mods = '') => w(`document.getElementById('grid').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ${mods} bubbles: true }))`);

/** Moves keyboard focus out of a webview, back to the workbench. */
async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.sidebar .composite.title')`);
}
async function openFile(name) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('p', { ctrl: true });
  await waitFor(() => vs.quickInputVisible(), { what: 'quick open' });
  await vs.type(name);
  // Right after start-up the file index may not be ready: wait for the item, then Enter.
  await waitFor(() => vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').includes(${JSON.stringify(name)}))`), { what: `${name} in quick open`, timeout: 15000 });
  await sleep(300);
  await vs.key('Enter');
  await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith(name)), { what: `${name} to open` });
  await sleep(400);
  await focusEditor();
}
async function focusEditor() {
  await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-instance .monaco-editor .view-lines')`);
  await sleep(150);
}
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
  await focusWorkbench();
  await vs.key('k', { ctrl: true });
  await vs.key('w', { ctrl: true });
  // An editor with unsaved edits asks first: don't keep them.
  await waitFor(
    async () => {
      if ((await vs.editorTabs()).length === 0) return true;
      await vs.eval(`[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((b) => /Don.t Save/.test(b.textContent))?.click()`);
      return false;
    },
    { what: 'editors to close' },
  );
}
/** Runs a command that opens its own quick pick (so the palette never "closes"). */
async function commandWithPick(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await waitFor(async () => (await vs.quickInputVisible()) && !(await vs.quickInputValue()).startsWith('>'), { what: `${title} quick pick` });
}
/** Closes the text editor that has focus (the file a jump opened), not the comparison. */
async function closeActiveEditor() {
  const before = (await vs.editorTabs()).length;
  await vs.key('w', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).length === before - 1, { what: 'the opened file to close' });
  await sleep(300);
}
async function chord(key, mods = {}) {
  await vs.key('k', { ctrl: true });
  await vs.key(key, mods);
}
async function statusBarSelection() {
  return vs.eval(`document.querySelector('[id="status.editor.selection"]')?.textContent ?? ''`);
}
async function setClipboard(text) {
  await focusWorkbench();
  await newUntitled();
  await vs.type(text);
  await vs.key('a', { ctrl: true });
  await vs.key('c', { ctrl: true });
  await sleep(200);
  await vs.command('View: Revert and Close Editor');
}
async function newUntitled() {
  await focusWorkbench();
  await vs.key('n', { ctrl: true });
  await waitFor(async () => (await vs.editorTabs()).some((t) => /^Untitled-\d+$/.test(t)), { what: 'untitled editor' });
  await sleep(300);
}
async function editorText() {
  return vs.eval(`[...document.querySelectorAll('.editor-instance .view-lines .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join('\\n').replace(/\\u00a0/g, ' ')`);
}
async function pasteIntoUntitled() {
  await newUntitled();
  await vs.key('v', { ctrl: true });
  await sleep(300);
  const text = await editorText();
  await vs.command('View: Revert and Close Editor');
  return text;
}
/** Opens the comparison of the two customers files, with updated_at ignored for the session. */
async function openCustomers() {
  await openFile('customers-v2.csv');
  await openFile('customers-v1.csv');
  await chord('c');
  await vs.pickQuickItem('customers-v2.csv');
  ctx = await vs.webview('customers-v2.csv');
  await until(`${W.stats}.includes('changed')`, 'stats');
}
/** Opens a column's header menu and clicks one of its entries. */
async function columnMenu(colName, entry) {
  await w(`(() => { const b = [...document.querySelectorAll('#head .hb')].find((x) => x.querySelector('.hn').textContent === ${JSON.stringify(colName)}); if (!b) throw new Error('no column ' + ${JSON.stringify(colName)}); b.click(); })()`);
  await until(`!document.getElementById('menu').hidden`, 'column menu');
  await w(`(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => x.textContent.includes(${JSON.stringify(entry)})); if (!b) throw new Error('no entry ' + ${JSON.stringify(entry)}); b.click(); })()`);
}

const ALL = '+1 added −1 removed ~11 changed in 5 columns ↕1 moved +1 column 1 renamed';
const IGN = '+1 added −1 removed ~3 changed in 4 columns ↕1 moved +1 column 1 renamed 11 ignored';

try {
  console.log(`VS Code profile: ${root}`);
  await vs.launch(ws);
  await sleep(3000);

  await step('Ctrl+K C compares the current file with an open editor', async () => {
    await openCustomers();
    eq(await w(W.heads), ['customers-v1.csv', 'customers-v2.csv'], 'column heads');
    eq(await w(W.stats), ALL, 'stats');
    ok((await vs.editorTabs()).some((t) => t.includes('customers-v1.csv ↔ customers-v2.csv')), 'panel title');
    eq(await w(W.headNotes('l')), ['12 rows × 9 columns', 'comma', 'header'], 'left head notes');
  });

  await step('the key column is picked from the preferred names', async () => {
    eq(await w(W.key), 'id', 'key chip');
    ok((await w(W.keybar)).includes('from the preferred names'), 'key mode');
    ok(await w(`!!document.querySelector('#head .cell.hd.key')`), 'key column marked in the header');
  });

  await step('sorting, quoting, number spelling and column order are not changes', async () => {
    ok(await w(`${W.rowWithText('Liam Nguyen')}.classList.contains('chg') && !${W.rowWithText('Liam Nguyen')}.querySelector('.cell.c')?.textContent.includes('1200')`), '1200 vs 1.2e3 is not a change');
    ok(await w(`${W.rowWithText('Omar Haddad')}.classList.contains('mvchg')`), 'the row that moved and changed');
    ok(await w(`!!document.querySelector('#head .badge.ren') && document.querySelector('#head .badge.ren').textContent === 'was country'`), 'renamed column');
    eq(await w(W.columns), ['id', 'name', 'email', 'plan', 'seats', 'mrr', 'region', 'signed_up', 'updated_at', 'notes'], 'merged column order');
  });

  await step('a column can be ignored from its header menu and saved to settings', async () => {
    await columnMenu('updated_at', 'Ignore differences here');
    await until(`${W.stats} === ${JSON.stringify(IGN)}`, 'stats after ignoring');
    ok((await w(W.keybar)).includes('Ignoring'), 'ignoring chip');
    await w(W.click('#saveIgnores'));
    const file = path.join(ws, '.vscode', 'settings.json');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('updated_at'), { what: 'workspace settings' });
    await until(`!!document.querySelector('#keybar .chip.saved')`, 'chip saved');
    eq(await w(W.stats), IGN, 'stats unchanged once saved');
  });

  await step('next / previous and F7 step through changes', async () => {
    await w(W.click('#next'));
    eq(await w(W.pos), '1 / 5', 'after next');
    await w(W.key7());
    eq(await w(W.pos), '2 / 5', 'after F7');
    await w(W.key7(true));
    eq(await w(W.pos), '1 / 5', 'after Shift+F7');
    await w(W.click('#prev'));
    eq(await w(W.pos), '5 / 5', 'wraps around');
    ok(await w(`!!document.querySelector('#rows .row.sel')`), 'current row selected');
  });

  if (shotsFor) {
    mkdirSync(shotsFor, { recursive: true });
    await w(`document.getElementById('grid').scrollTop = 0`);
    await w(W.click('#next'));
    await sleep(500);
    await shotOfEditor(path.join(shotsFor, 'overview-dark.png'));
  }

  await step('click shows the row detail; the footer names both lines', async () => {
    await w(`${W.rowWithText('Noah Schmidt')}.children[4].click()`);
    const f = await w(W.footer);
    ok(f.startsWith('changed 108 Left, line 9 Right, line 9'), f);
    ok(f.includes('email: noah@example.com → noah.schmidt@example.com'), f);
  });

  await step('changes only, filters by status and column', async () => {
    const all = +(await w(W.visible));
    await w(W.check('changesOnly', true));
    eq(await w(W.visible), '6', 'five changed rows plus the header');
    await w(W.check('changesOnly', false));
    eq(+(await w(W.visible)), all, 'rows back');
    await w(W.click('#filter'));
    await w(`document.querySelector('#menu input[data-status="2"]').click()`);
    eq(await w(W.visible), '2', 'only the added row');
    ok(await w(`document.getElementById('filter').textContent.includes('Filter (1)')`), 'the Filter button says a filter is on');
    ok((await w(W.keybar)).includes('Showing 1 of'), 'the key bar says rows are hidden');
    await w(`document.querySelector('#menu input[data-status="2"]').click()`);
    await w(`(() => { const s = document.getElementById('filter-col'); s.value = [...s.options].find((o) => o.textContent === 'email').value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq(await w(W.visible), '2', 'only the row whose email changed');
    ok(await w(`!!${W.rowWithText('Noah Schmidt')}`), 'Noah is the one');
    await w(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.includes('Clear filters')).click()`);
    eq(+(await w(W.visible)), all, 'filters cleared');
  });

  await step('columns can be hidden and shown', async () => {
    await w(W.click('#columns'));
    await w(`[...document.querySelectorAll('#menu label')].find((l) => l.textContent.trim() === 'signed_up').querySelector('input').click()`);
    ok(!(await w(W.columns)).includes('signed_up'), 'hidden');
    await w(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.includes('Only changed and key columns')).click()`);
    eq(await w(W.columns), ['id', 'email', 'plan', 'seats', 'mrr', 'region', 'notes'], 'changed and key columns (ignored ones hidden too)');
    await w(W.click('#columns'));
    await w(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.includes('Show all')).click()`);
    eq((await w(W.columns)).length, 10, 'all back');
  });

  await step('side by side shows each table in its own column order', async () => {
    await w(W.click('[data-view="sideBySide"]'));
    const cols = await w(W.columns);
    eq(cols.length, 19, 'nine left columns and ten right');
    eq(cols.slice(0, 9), ['id', 'name', 'email', 'plan', 'seats', 'mrr', 'country', 'signed_up', 'updated_at'], 'left side keeps its own names');
    ok(await w(`${W.rowWithText('Kenji Sato')}.querySelectorAll('.cell.fill').length === 10`), 'the removed row is blank on the right');
    ok(await w(`!!${W.rowWithText('Noah Schmidt')}.querySelector('.cell.cl') && !!${W.rowWithText('Noah Schmidt')}.querySelector('.cell.cr')`), 'changed cells marked on both sides');
    if (shotsFor) {
      const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
      writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
      await sleep(2000);
      // Few enough columns that both tables fit the frame.
      await w(W.click('#columns'));
      await w(`[...document.querySelectorAll('#menu label')].filter((l) => !['id', 'name', 'plan', 'seats'].includes(l.textContent.trim().split(' ')[0])).forEach((l) => { const i = l.querySelector('input'); if (i.checked) i.click(); })`);
      await w(W.click('#columns'));
      await sleep(300);
      await w(`${W.rowWithText('Noah Schmidt')}.children[2].click()`);
      await w(`document.getElementById('grid').scrollLeft = 0`);
      await sleep(400);
      await shotOfEditor(path.join(shotsFor, 'side-by-side-light.png'));
      await w(W.click('#columns'));
      await w(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.includes('Show all')).click()`);
      writeFileSync(userSettings, JSON.stringify(settings, null, 2));
      await sleep(2000);
    }
    await w(W.click('[data-view="unified"]'));
    eq((await w(W.columns)).length, 10, 'unified again');
  });

  await step('keyboard: arrows move the active cell, Enter opens the row in its file', async () => {
    await w(`document.getElementById('grid').focus()`);
    await gridKey('Home', 'ctrlKey: true,');
    await gridKey('ArrowDown');
    await gridKey('ArrowDown');
    await gridKey('ArrowRight');
    eq(await w(`document.getElementById('grid').getAttribute('aria-activedescendant')`), 'c-2-1', 'active cell');
    ok((await w(W.footer)).startsWith('changed 103'), 'footer follows the selection');
    await gridKey('End');
    eq(await w(`document.getElementById('grid').getAttribute('aria-activedescendant')`), 'c-2-9', 'last column');
    await gridKey('Enter');
    await waitFor(async () => (await statusBarSelection()).includes('Ln 5,'), { what: 'the right file at line 5' });
    ok((await vs.editorTabs()).filter((t) => t.startsWith('customers-v2.csv')).length >= 1, 'right file opened');
    await closeActiveEditor();
    await vs.showTab('customers-v1.csv ↔');
    ctx = await vs.webview('customers-v2.csv');
  });

  await step('double-click opens the left file at that line', async () => {
    await w(`${W.rowWithText('Kenji Sato')}.children[4].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(async () => (await statusBarSelection()).includes('Ln 6,'), { what: 'the left file at line 6' });
    await closeActiveEditor();
    await vs.showTab('customers-v1.csv ↔');
    ctx = await vs.webview('customers-v2.csv');
  });

  await step('Ctrl+F finds cells, steps through matches, filters to them', async () => {
    const count = `document.getElementById('find-count').textContent`;
    const type = (text) => w(`(() => { const q = document.getElementById('find-q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); })()`);
    await w(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`);
    ok(await w(`!document.getElementById('find').hidden && document.activeElement.id === 'find-q'`), 'find bar open and focused');
    await type('example.com');
    await until(`${count} === '1 of 12 rows'`, 'matches');
    ok(await w(`!!document.querySelector('#rows .row.hit mark')`), 'match highlighted');
    await w(`document.getElementById('find-q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    eq(await w(count), '2 of 12 rows', 'next');
    await type('team');
    await until(`${count} === '1 of 4 rows'`, 'team matches');
    await w(W.click('#find-only'));
    eq(await w(W.visible), '5', 'only matching rows');
    await w(`(() => { const s = document.getElementById('find-col'); s.value = [...s.options].find((o) => o.textContent === 'notes').value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(`${count} === 'No results'`, 'no team in notes');
    await w(`document.getElementById('find-q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    ok(await w(`document.getElementById('find').hidden && !document.querySelector('#rows mark')`), 'closed and cleared');
    eq(await w(W.visible), '14', 'all rows back');
  });

  await step('ignore order drops the move; options survive a settings change', async () => {
    await w(W.check('ignoreRowOrder', true));

    await until(`!${W.stats}.includes('↕')`, 'no moves');
    eq(await w(W.stats), '+1 added −1 removed ~3 changed in 4 columns +1 column 1 renamed 11 ignored', 'stats');
    await w(W.check('ignoreRowOrder', false));
    await until(`${W.stats} === ${JSON.stringify(IGN)}`, 'moves back');
  });

  await step('the key can be changed from the view', async () => {
    await w(W.click('#keychip'));
    await waitFor(() => vs.quickInputVisible(), { what: 'key quick pick' });
    // A multi-select: tick email, untick id, accept.
    const tick = (label) => vs.clickElement(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find((r) => r.getAttribute('aria-label') === ${JSON.stringify(label)})?.querySelector('.monaco-checkbox')`);
    await sleep(300);
    await tick('id');
    await sleep(300);
    await tick('email');
    await waitFor(() => vs.eval(`document.querySelector('.quick-input-widget .quick-input-count')?.textContent.includes('1')`), { what: 'one column ticked' });
    await vs.clickElement(`[...document.querySelectorAll('.quick-input-widget .monaco-button')].find((b) => b.textContent.trim() === 'OK')`);
    await waitFor(async () => !(await vs.quickInputVisible()), { what: 'key quick pick to close' });
    await until(`${W.key} === 'email'`, 'key is email');
    ok((await w(W.keybar)).includes('chosen here'), 'key mode');
    eq(await w(W.stats), '+2 added −2 removed ~2 changed in 3 columns ↕1 moved +1 column 1 renamed 10 ignored', 'by email, the changed address is a removal and an addition');
  });

  await step('the key can be saved for files with a similar name', async () => {
    await w(W.click('#saveKeys'));
    await vs.answerInput('customers-*.csv');
    const file = path.join(ws, '.vscode', 'settings.json');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('customers-*.csv'), { what: 'keysByFile in workspace settings' });
    ok(readFileSync(file, 'utf8').includes('"email"'), 'the key');
  });

  await step('Automatic key: back from a key chosen here', async () => {
    await w(`document.querySelector('[data-act="autoKey"]').click()`);
    await until(`!document.querySelector('[data-act="autoKey"]')`, 'no link once automatic');
    ok((await w(W.keybar)).includes('for files like customers-*.csv'), 'key from the saved file pattern');
    eq(await w(W.key), 'email', 'the saved key');
  });

  await step('Export: copy as Markdown reaches the clipboard', async () => {
    await w(W.click('#export'));
    await w(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent.includes('Copy as Markdown')).click()`);
    await sleep(400);
    const md = await pasteIntoUntitled();
    ok(md.startsWith('`customers-v1.csv` → `customers-v2.csv`: 2 added, 2 removed, 2 changed in 3 columns, 1 moved, 1 column added, 1 column renamed (10 ignored)'), md.slice(0, 200));
    ok(md.includes('Rows matched by `email`.'), 'key line');
    ok(md.includes('| ~ | `ops@acme.example` |'), 'a changed row');
    await vs.showTab('customers-v1.csv ↔');
    ctx = await vs.webview('customers-v2.csv');
  });

  await step('the view follows edits to the file', async () => {
    await openFile('customers-v2.csv');
    await vs.key('End', { ctrl: true });
    await vs.type('114,Test Person,test@example.com,free,1,0,VN,2025-10-02,2025-10-01T09:30:00Z,\n');
    await vs.showTab('customers-v1.csv ↔');
    ctx = await vs.webview('customers-v2.csv');
    await until(`${W.stats}.includes('+3 added')`, 'added row to show up', 8000);
    await openFile('customers-v2.csv');
    await vs.command('File: Revert File');
    await vs.showTab('customers-v1.csv ↔');
    ctx = await vs.webview('customers-v2.csv');
    await until(`${W.stats}.includes('+2 added')`, 'undo to show up', 8000);
  });

  await step('swap sides', async () => {
    await w(W.click('#swap'));
    await until(`${W.heads}[0] === 'customers-v2.csv'`, 'heads swapped');
    eq(await w(W.heads), ['customers-v2.csv', 'customers-v1.csv'], 'heads');
    await until(`${W.stats}.includes('−1 column')`, 'stats swapped');
    await w(W.click('#swap'));
    await until(`${W.heads}[0] === 'customers-v1.csv'`, 'heads back');
  });

  await step('Ctrl+K Shift+C compares the selection with the clipboard', async () => {
    await closeAll();
    await setClipboard('id,name,plan\n102,Liam Nguyen,pro\n101,Mai Tran,pro\n');
    await openFile('customers-v1.csv');
    await vs.key('Home', { ctrl: true });
    await vs.key('l', { ctrl: true });
    await vs.key('l', { ctrl: true });
    await vs.key('l', { ctrl: true }); // header plus two rows
    await chord('c', { shift: true });
    ctx = await vs.webview('customers-v1.csv (selection)');
    eq(await w(W.heads), ['customers-v1.csv (selection)', 'Clipboard'], 'heads');
    ok(await w(`document.querySelector('.head.l .detail .path').textContent.endsWith('lines 1–3')`), 'three lines selected');
    await until(`${W.stats}.includes('changed')`, 'stats');
    eq(await w(W.stats), '~1 changed in 1 column ↕1 moved −6 columns', 'stats');
  });

  await step('Compare with HEAD', async () => {
    await closeAll();
    await openFile('products.csv');
    await vs.command('CSV Semantic Diff: Compare with HEAD');
    ctx = await vs.webview('products.csv (HEAD)');
    eq(await w(W.heads), ['products.csv (HEAD)', 'products.csv'], 'heads');
    await until(`${W.stats}.includes('changed')`, 'stats');
    eq(await w(W.stats), '~1 changed in 1 column', 'only the stock changed');
    eq(await w(W.key), 'sku', 'key');
  });

  await step('Compare with a Git revision', async () => {
    await closeAll();
    await openFile('products.csv');
    await commandWithPick('CSV Semantic Diff: Compare with Git Revision');
    await vs.pickQuickItem('HEAD~1');
    ctx = await vs.webview('products.csv (HEAD~1)');
    await until(`${W.stats}.includes('added')`, 'stats');
    eq(await w(W.stats), '+1 added ~2 changed in 2 columns', 'against the first commit');
  });

  await step('Ctrl+K C in a Source Control diff opens it semantically', async () => {
    await closeAll();
    await openFile('products.csv');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Changes"]')`);
    await waitFor(async () => await vs.eval(`!!document.querySelector('.editor-instance .monaco-diff-editor')`), { what: 'diff editor' });
    await sleep(600);
    ok(await vs.eval(`!!document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Open Diff Semantically"]')`), 'title button in the diff editor');
    await vs.clickElement(`document.querySelector('.editor-group-container.active .monaco-diff-editor .editor.modified .view-lines')`);
    await chord('c');
    ctx = await vs.webview('products.csv (Index)');
    await until(`${W.stats}.includes('changed')`, 'stats');
    eq(await w(W.stats), '~1 changed in 1 column', 'stats');
  });

  await step('Select for compare, then Compare with Selected', async () => {
    await closeAll();
    await openFile('inventory-v1.tsv');
    await vs.command('CSV Semantic Diff: Select for CSV Compare');
    await openFile('inventory-v2.tsv');
    await vs.command('CSV Semantic Diff: Compare as CSV with Selected');
    ctx = await vs.webview('inventory-v1.tsv');
    eq(await w(W.heads), ['inventory-v1.tsv', 'inventory-v2.tsv'], 'heads');
    await until(`${W.stats}.includes('changed')`, 'stats');
    eq(await w(W.stats), '+1 added −1 removed ~4 changed in 3 columns', 'tsv stats');
    eq(await w(W.headNotes('l')), ['5 rows × 5 columns', 'tab', 'header'], 'tab detected');
    eq(await w(W.key), 'sku', 'key from the preferred names');
  });

  await step('Explorer: two selected files, Compare as CSV', async () => {
    await closeAll();
    await vs.clickElement(`document.querySelector('.explorer-folders-view .monaco-list-row[aria-label^="customers-v1.csv"]')`);
    await sleep(200);
    const box = await vs.eval(`(() => { const e = document.querySelector('.explorer-folders-view .monaco-list-row[aria-label^="customers-v2.csv"]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await vs.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 2 });
    await sleep(200);
    for (const type of ['mousePressed', 'mouseReleased']) await vs.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
    // The menu lives in a shadow root and ignores synthetic clicks: walk it with the keyboard.
    const labels = await waitFor(
      () =>
        vs.eval(`(() => { const roots = [document, ...[...document.querySelectorAll('.context-view *')].filter((e) => e.shadowRoot).map((e) => e.shadowRoot)]; const l = roots.flatMap((r) => [...r.querySelectorAll('.action-label')]).map((x) => x.textContent.trim()).filter(Boolean); return l.includes('Compare as CSV') && l; })()`),
      { what: 'Compare as CSV in the context menu' },
    );
    for (let i = 0; i <= labels.indexOf('Compare as CSV'); i++) await vs.key('ArrowDown');
    await vs.key('Enter');
    ctx = await vs.webview('customers-v2.csv');
    eq(await w(W.heads), ['customers-v1.csv', 'customers-v2.csv'], 'heads');
  });

  await step('Ctrl+K Alt+C opens an empty comparison to paste into; delimiter and header can be set', async () => {
    await closeAll();
    await focusWorkbench();
    await chord('c', { alt: true });
    ctx = await vs.webview('Left');
    ok(await w(`!document.getElementById('editors').hidden`), 'editors open');
    ok(await w(`!!document.querySelector('.problem.empty')`), 'empty hint');
    await w(`(() => { for (const [id, v] of [['ed-left', 'a;b;c\\n1;2;3\\n'], ['ed-right', 'a;b;c\\n1;2;4\\n']]) { const t = document.getElementById(id); t.value = v; t.dispatchEvent(new Event('input')); } })()`);
    await until(`${W.stats}.includes('changed')`, 'diff');
    eq(await w(W.stats), '~1 changed in 1 column', 'stats');
    eq(await w(W.headNotes('r')), ['1 row × 3 columns', 'semicolon', 'header'], 'semicolon detected');
    await w(`(() => { const s = document.querySelector('[data-header="right"]'); s.value = 'false'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(`${W.headNotes('r')}.includes('no header')`, 'no header');
    // The left side, still automatic, follows the choice made for the right.
    await until(`${W.headNotes('l')}.includes('no header')`, 'the left follows');
    eq(await w(W.headNotes('r')), ['2 rows × 3 columns', 'semicolon', 'no header'], 'header row read as data');
    eq(await w(W.stats), '~1 changed in 1 column', 'still lines up');
    await w(`(() => { const s = document.querySelector('[data-header="right"]'); s.value = 'auto'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(`${W.headNotes('l')}.includes('header') && !${W.headNotes('l')}.includes('no header')`, 'header again');
    eq(await w(W.stats), '~1 changed in 1 column', 'stats');
  });

  await step('Change… picks the clipboard for a side', async () => {
    await setClipboard('a;b;c\n1;2;3\n');
    await vs.showTab('Left ↔ Right');
    ctx = await vs.webview('Left');
    await w(W.click('[data-pick="right"]'));
    await vs.pickQuickItem('Clipboard');
    await until(`${W.heads}[1] === 'Clipboard'`, 'right is clipboard');
    await until(`${W.stats}.startsWith('✓')`, 'no differences');
    eq(await w(W.stats), '✓ No differences', 'stats');
  });

  if (shotsFor) {
    await closeAll();
    await openCustomers();
    await w(W.check('changesOnly', true));
    await sleep(400);
    await w(W.click('#next'));
    await sleep(300);
    await shotOfEditor(path.join(shotsFor, 'changes-only-dark.png'));
    await w(W.check('changesOnly', false));
  }

  await step('the title bar button opens an empty comparison', async () => {
    await openFile('products.csv');
    const btn = `document.querySelector('.editor-group-container.active .editor-actions [aria-label^="New CSV Comparison"]')`;
    ok(await vs.eval(`!!${btn}`), 'button in the editor title');
    await vs.clickElement(btn);
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.startsWith('Left ↔ Right')), { what: 'an empty comparison' });
    ctx = await vs.webview('Left');
    ok(await w(`!document.getElementById('editors').hidden`), 'paste boxes open');
  });

  await step('the comparison comes back after Reload Window', async () => {
    await closeAll();
    await openCustomers();
    await openFile('products.csv');
    await vs.command('CSV Semantic Diff: Compare with HEAD');
    ctx = await vs.webview('products.csv (HEAD)');
    await sleep(500);
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('customers-v1.csv ↔ customers-v2.csv')), { timeout: 20000, what: 'restored tab' });
    await vs.showTab('customers-v1.csv ↔');
    ctx = await vs.webview('customers-v2.csv', 20000);
    await until(`${W.stats}.includes('changed')`, 'restored comparison');
    eq(await w(W.key), 'email', 'the saved per-file key applies');
    await vs.showTab('products.csv (HEAD) ↔');
    ctx = await vs.webview('products.csv (HEAD)', 20000);
    await until(`${W.stats} === '~1 changed in 1 column'`, 'restored HEAD comparison');
  });

  await step('Restricted Mode: workspace settings are not applied and Git is refused', async () => {
    await closeAll();
    // Turning workspace trust on needs a restart: stop VS Code and start it again.
    await vs.close();
    const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
    writeFileSync(userSettings, JSON.stringify({ ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'always' }, null, 2));
    vs.contexts.clear();
    await vs.launch(ws);
    await sleep(2000);
    await vs.dialogButton("No, I don't trust the authors", 30000);
    await sleep(1500);
    await waitFor(() => vs.eval(`document.querySelector('.part.statusbar')?.textContent.includes('Restricted Mode')`), { timeout: 20000, what: 'Restricted Mode' });
    await openCustomers();
    ok((await w(W.keybar)).includes('Restricted Mode'), 'restricted note');
    eq(await w(W.key), 'id', 'the workspace key setting (email) is not applied');
    eq(await w(W.stats), ALL, 'the workspace ignore setting is not applied either');
    await openFile('products.csv');
    await vs.clearNotifications();
    await vs.command('CSV Semantic Diff: Compare with HEAD');
    await waitFor(async () => (await vs.notifications()).some((n) => n.includes('trusted workspace')), { what: 'refusal' });
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
} finally {
  await vs.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}
