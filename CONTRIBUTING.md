# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the smallest pair of tables that shows the problem, what you expected
and what you saw. The output of **Export → Copy as Markdown** helps.

## Running from source

Node 22 or newer.

```bash
git clone https://github.com/heyliamme/csv-semantic-diff
cd csv-semantic-diff
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host with the extension
loaded and the samples folder open.

## Tests

```bash
npm test
```

- `test/parse.test.mjs` covers the reader (quoting, line ends, delimiters, headers,
  ragged rows) and the normalisation rules.
- `test/diff.test.mjs` covers key detection, row matching by key and by content, column
  matching and renames, moves, and the session (windows, search).
- `test/export.test.mjs` covers the Markdown, highlighter CSV and JSON exports and the
  defusing of formulas.
- `test/render.test.mjs` covers the grid's HTML: escaping, both views, placeholders.
- `test/perf.test.mjs` compares 100k × 20 tables and prints the timings.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile and
uses it as a person would: shortcuts, menus, quick picks, the clipboard, Git, every
control in the view, a window reload and Restricted Mode. VS Code runs headless, so it
doesn't take over your screen. Linux only (it uses Chromium's headless mode), with
`code` on your `PATH` (or set `VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
```

Screenshots of failing steps land in the temporary folder it prints.
`E2E_SHOTS=images npm run test:e2e` also writes the README screenshots.

## Working on the view in a browser

```bash
npm run build
node harness/preview.mjs samples/customers-v1.csv samples/customers-v2.csv
google-chrome "file://$PWD/out/preview.html?theme=light&view=sideBySide"
```

`?rows=100000` generates a large table instead of reading the files.

## Layout

| Path | |
| --- | --- |
| `src/core/parse.ts` | The CSV/TSV reader, delimiter and header detection |
| `src/core/normalize.ts` | How two cells are compared |
| `src/core/columns.ts` | Column matching and rename detection |
| `src/core/keys.ts` | Key column detection |
| `src/core/diff.ts` | Row matching by key and by content, moves, the summary |
| `src/core/export.ts` | Markdown, highlighter CSV and JSON |
| `src/core/session.ts` | One comparison: tables, result, windows of rows, search |
| `src/worker.ts` | The session in a worker thread |
| `src/panel.ts` | The webview panel, sources, settings, live updates |
| `src/git.ts` | Reading a file at a Git revision |
| `src/extension.ts` | Commands |
| `webview/render.ts` | Rows and headers as HTML |
| `webview/main.ts` | The view's UI |

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include screenshots in light and dark themes.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
