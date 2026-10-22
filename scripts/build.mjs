import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');
if (prod) rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18' },
  // The parser and the comparison run in a worker thread, so the extension host stays responsive.
  { ...common, entryPoints: ['src/worker.ts'], outfile: 'dist/worker.js', platform: 'node', format: 'cjs', target: 'node18' },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' },
  // The core on its own: for the tests (node) and the browser harness (iife).
  { ...common, entryPoints: ['src/core/index.ts'], outfile: 'dist/core.js', platform: 'node', format: 'cjs', target: 'node18', sourcemap: false },
  { ...common, entryPoints: ['src/core/index.ts'], outfile: 'dist/core.browser.js', platform: 'browser', format: 'iife', globalName: 'CsvCore', target: 'es2022', sourcemap: false },
  // The grid's HTML on its own, for the tests.
  { ...common, entryPoints: ['webview/render.ts'], outfile: 'dist/render.js', platform: 'node', format: 'cjs', target: 'node18', sourcemap: false },
];

const copyCss = () => {
  copyFileSync('webview/style.css', 'dist/webview.css');
  for (const f of ['codicon.css', 'codicon.ttf']) copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/${f}`);
};
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  copyCss();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyCss();
}
