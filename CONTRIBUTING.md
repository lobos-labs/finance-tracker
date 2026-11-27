# Contributing

## Issues are welcome

Open an issue for a bug, a number that looks wrong, a bank file that won't
import, or something you'd like the app to do. Support isn't promised, and
there's no timeline for fixes or requests, but every issue is read.

A useful report has:

- the app's version (**Settings → Data**) and your operating system
- what you did, what you expected, and what happened instead
- for an import problem, the file type (CSV, QFX, OFX or QIF) and a few rows
  that show it, with made-up names and amounts in the same layout

**Never post your real financial data**: no real names, account or card
numbers, balances, statements, screenshots of your books, API keys or
SimpleFIN setup tokens. **Copy diagnostics** includes your folder paths, which
can contain your user name; read it before you paste it. If you need a
screenshot, **Load sample data** (the last step of setup, or the empty pages)
fills the app with a made-up household.

Security problems go through private reporting, not an issue: see
[SECURITY.md](SECURITY.md).

## Pull requests aren't accepted yet

Pull requests are closed without review for now. If that changes, this file
will say how to send one. An issue that describes the fix is welcome instead.

## Forks

You can fork the code under its license. A fork you distribute needs a
different name and icon: see [TRADEMARKS.md](TRADEMARKS.md).

## Working on the code

[Build from source](README.md#build-from-source) in the README has the
commands. `npm test` runs the tests on a plain and on an encrypted database,
and `npm run typecheck` checks the types. A run from source keeps its own
data folder (`Finance Tracker Dev`), apart from the books of an installed
copy; set `FINANCE_TRACKER_DATA_DIR` to point it at a scratch folder instead.
