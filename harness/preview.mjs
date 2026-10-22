// Renders the real webview outside VS Code, for UI work and screenshots. The host side is
// emulated in the page with the core bundle, so the view talks the real protocol.
//
//   npm run build
//   node harness/preview.mjs samples/customers-v1.csv samples/customers-v2.csv
//   google-chrome --headless=new --window-size=1280,860 --screenshot=out/dark.png "file://$PWD/out/preview.html?theme=dark"
//
// Query parameters: theme=dark|light, view=sideBySide, changesOnly=1, order=1 (ignore
// row order), next=N (step to the Nth change), select=N (click visible row N),
// find=text, keys=a,b (key columns), rows=N (generate N rows instead of the files).
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [leftFile = 'samples/customers-v1.csv', rightFile = 'samples/customers-v2.csv'] = process.argv.slice(2);
const read = (f) => readFileSync(path.resolve(f), 'utf8');

const THEMES = {
  dark: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-panel-border:#2b2b2b;--vscode-sideBar-background:#181818;--vscode-editorGroupHeader-tabsBackground:#181818;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-inactiveSelectionBackground:#37373d;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-button-secondaryForeground:#cccccc;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-editor-font-size:13px;--vscode-editorLineNumber-foreground:#6e7681;--vscode-diffEditor-insertedLineBackground:rgba(155,185,85,.2);--vscode-diffEditor-removedLineBackground:rgba(255,0,0,.2);--vscode-diffEditor-insertedTextBackground:rgba(156,204,44,.3);--vscode-diffEditor-removedTextBackground:rgba(255,0,0,.4);--vscode-textLink-foreground:#4daafc;--vscode-dropdown-background:#313131;--vscode-dropdown-border:#3c3c3c;--vscode-menu-background:#1f1f1f;--vscode-menu-border:#454545;`,
  light: `--vscode-font-family:-apple-system,"Segoe UI",Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-panel-border:#e5e5e5;--vscode-sideBar-background:#f8f8f8;--vscode-editorGroupHeader-tabsBackground:#f8f8f8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-inactiveSelectionBackground:#e4e6f1;--vscode-input-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-descriptionForeground:#717171;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryHoverBackground:#cccccc;--vscode-button-secondaryForeground:#3b3b3b;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-editor-font-family:"Cascadia Code","DejaVu Sans Mono",Menlo,monospace;--vscode-editor-font-size:13px;--vscode-editorLineNumber-foreground:#6e7681;--vscode-diffEditor-insertedLineBackground:rgba(155,185,85,.2);--vscode-diffEditor-removedLineBackground:rgba(255,0,0,.12);--vscode-diffEditor-insertedTextBackground:rgba(156,204,44,.4);--vscode-diffEditor-removedTextBackground:rgba(255,0,0,.25);--vscode-textLink-foreground:#005fb8;--vscode-dropdown-background:#ffffff;--vscode-dropdown-border:#cecece;--vscode-menu-background:#ffffff;--vscode-menu-border:#cecece;`,
};

const files = { left: { label: path.basename(leftFile), detail: leftFile, text: read(leftFile) }, right: { label: path.basename(rightFile), detail: rightFile, text: read(rightFile) } };

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>:root{${THEMES.dark}} :root.light{${THEMES.light}}</style>
<link rel="stylesheet" href="codicon.css">
<style>${read(path.join(root, 'dist/webview.css'))}</style></head>
<body><div id="app"></div>
<script>${read(path.join(root, 'dist/core.browser.js'))}</script>
<script>
const q = new URLSearchParams(location.search);
if (q.get('theme') === 'light') { document.documentElement.classList.add('light'); document.body.className = 'vscode-light'; }
else document.body.className = 'vscode-dark';
const files = ${JSON.stringify(files).replace(/</g, '\\u003c')};
if (q.get('rows')) {
  const n = +q.get('rows');
  const gen = (mut) => { const lines = ['id,name,qty,price,note']; for (let i = 0; i < n; i++) { const c = [String(i + 1), 'Item ' + i, String(i % 50), (i * 1.5).toFixed(2), 'n' + (i % 7)]; lines.push((mut ? mut(i, c) : c).join(',')); } return lines.join('\\n'); };
  files.left.text = gen(); files.right.text = gen((i, c) => { if (i % 97 === 0) c[2] = 'x'; if (i % 1000 === 5) c[1] = 'Renamed ' + i; return c; });
}
// The host, emulated: the same requests the extension answers, answered here by the core.
const session = new CsvCore.Session();
let gen = 0;
const sides = { left: { ...files.left, delimiter: 'auto', header: 'auto' }, right: { ...files.right, delimiter: 'auto', header: 'auto' } };
const options = { keyColumns: ['id', 'ID', '_id', 'uuid', 'key', 'code', 'sku', 'email', 'name'], ignoreColumns: [], normalizeNumbers: true, thousandsSeparators: false, trimWhitespace: true, ignoreCase: false, emptyEqualsMissing: true, ignoreRowOrder: !!q.get('order'), changesOnly: !!q.get('changesOnly'), view: q.get('view') === 'sideBySide' ? 'sideBySide' : 'unified', restricted: false };
let keys = q.get('keys') ? q.get('keys').split(',') : undefined;
let sessionIgnores = [];
const data = (s) => ({ label: s.label, detail: s.detail, canReveal: true, editable: false, delimiter: s.delimiter, header: s.header, restore: { label: s.label } });
const send = (m) => window.postMessage(m, '*');
function compute() {
  gen++;
  session.labels = { left: sides.left.label, right: sides.right.label };
  for (const side of ['left', 'right']) session.load(side, { text: sides[side].text, delimiter: sides[side].delimiter, header: sides[side].header, hint: sides[side].label.endsWith('.tsv') ? '\\t' : undefined });
  const result = session.compare({ ...options, keys, ignoreColumns: [...options.ignoreColumns, ...sessionIgnores] }, { left: !!sides.left.text.trim(), right: !!sides.right.text.trim() });
  send({ type: 'result', gen, result, keys, lines: { left: session.lines('left'), right: session.lines('right') } });
}
window.acquireVsCodeApi = () => ({ setState: () => {}, getState: () => undefined, postMessage: (m) => {
  if (m.type !== 'window') console.log('host <-', JSON.stringify(m).slice(0, 200));
  switch (m.type) {
    case 'ready': send({ type: 'init', left: data(sides.left), right: data(sides.right), options }); setTimeout(compute, 0); waitThen(afterLoad); break;
    case 'window': send({ type: 'window', gen: m.gen, window: session.window(m.from, m.to) }); break;
    case 'search': send({ type: 'search', gen: m.gen, id: m.id, ...session.search(m.query) }); break;
    case 'options': Object.assign(options, m.options); if (Object.keys(m.options).some((k) => k !== 'changesOnly' && k !== 'view')) compute(); break;
    case 'keys': keys = m.keys ?? undefined; compute(); break;
    case 'ignore': sessionIgnores = m.columns; compute(); break;
    case 'sideOptions': sides[m.side].delimiter = m.delimiter; sides[m.side].header = m.header; send({ type: 'side', side: m.side, data: data(sides[m.side]) }); compute(); break;
    case 'swap': { const t = sides.left; sides.left = sides.right; sides.right = t; send({ type: 'side', side: 'left', data: data(sides.left) }); send({ type: 'side', side: 'right', data: data(sides.right) }); compute(); break; }
    case 'export': console.log(session.export(m.format)); break;
    case 'pickKeys': keys = keys ? undefined : ['email']; compute(); break;
  }
}});
function waitThen(fn, tries = 0) {
  if (document.getElementById('stats').textContent.trim() && document.querySelector('#rows .row:not(.loading)')) fn();
  else if (tries < 100) setTimeout(() => waitThen(fn, tries + 1), 30);
}
function afterLoad() {
  const click = (el) => el && el.click();
  for (let i = 0; i < +(q.get('next') || 0); i++) click(document.getElementById('next'));
  if (q.get('select')) document.querySelector('.row[data-v="' + q.get('select') + '"] .cell:nth-child(5)')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  if (q.get('find')) { click(document.getElementById('openFind')); const f = document.getElementById('find-q'); f.value = q.get('find'); f.dispatchEvent(new Event('input')); }
  if (q.get('menu')) click(document.getElementById(q.get('menu')));
}
</script>
<script>${read(path.join(root, 'dist/webview.js'))}</script>
</body></html>`;

mkdirSync(path.join(root, 'out'), { recursive: true });
writeFileSync(path.join(root, 'out/preview.html'), html);
for (const f of ['codicon.css', 'codicon.ttf']) writeFileSync(path.join(root, 'out', f), readFileSync(path.join(root, 'dist', f)));
console.log(path.join(root, 'out/preview.html'));
