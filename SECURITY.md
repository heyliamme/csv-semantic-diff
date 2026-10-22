# Security policy

The extension parses files you open and renders them in a webview, so bugs that let the
content of a CSV file run script in that webview, read files you didn't choose, or slip
a live formula into an export are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/csv-semantic-diff/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: script execution or HTML injection from file content (cells, column names, file
names), reading files other than the ones the user picked, exports that would run as a
formula when opened in a spreadsheet, workspace settings taking effect in Restricted
Mode, and anything that sends data off the machine.
