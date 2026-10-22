# Changelog

## 0.1.0

First release.

- Rows matched by a key column found automatically (preferred names, then any unique
  column, then pairs of columns), chosen in the view, or saved per file name pattern;
  composite keys; repeated keys matched in order of appearance; a column that only
  numbers the rows (a pandas index, `#`) is not taken as the key; **Automatic** brings
  the found key back after choosing one.
- Without a key, rows aligned by content: moves and edited rows still pair up.
- Row order, column order, quoting and number spelling are not changes; added, removed,
  changed and moved rows; added, removed and renamed columns; cell-level old → new.
- Normalisation switches: numbers (exact at any length, decimal commas in semicolon
  files), thousands separators, whitespace, case, empty = missing, ignore row
  order; ignored columns, saved to settings from the view (per folder in a multi-root
  workspace).
- Unified and side-by-side tables, virtualised for large files, with filters by status
  and column, find with regular expressions, column show/hide, keyboard navigation and
  an ARIA grid, light, dark and high-contrast themes, and jumping to a row in either file.
- Compare with another file, the clipboard, the selection, HEAD, any Git revision, or the
  two sides of a diff editor; two files from the Explorer; an empty comparison to paste
  into; delimiter and header row detected and overridable per side (a side left on
  automatic follows a header choice made for the other).
- Export as Markdown (clipboard, every value as inline code), daff-style highlighter CSV
  (spreadsheet formulas defused) or JSON.
- Comparisons come back after a window reload; the comparison runs in a worker thread.
- In Restricted Mode, comparison settings from the workspace are not applied and Git is
  not used.
