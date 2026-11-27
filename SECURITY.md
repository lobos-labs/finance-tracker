# Security

## Reporting a problem

Report it privately to Lobos Labs through GitHub: on this repository's
**Security** tab, choose **Report a vulnerability**. Please don't open a public issue, and don't
include anyone's real financial data; a made-up file or the app's sample data
is enough to show most problems.

Say which version you tested (**Settings → Data**), on which operating system,
and how to reproduce it. There's no bug bounty and no promised response time,
but every report is read. Fixes go out as new releases.

## What's in scope

**The encrypted books file.** `finance.db`, its write-ahead log and its
backups, encrypted with ChaCha20-Poly1305 (SQLite3MultipleCiphers) under a
random 256-bit key. The key file, `finance.key`, holds that key only sealed: by
the OS keystore (Electron's safeStorage), on Windows also by DPAPI for the user
account, and by the recovery code (scrypt with N = 2^17, r = 8, p = 1, then
AES-256-GCM). In scope: reading the books without the user's OS account or
recovery code, a backup or a copied key file that opens with less than it
should, a replaced recovery code that opens anything written after it was
replaced, and the recovery code leaking to disk, the clipboard or a screen
capture.

**The Claude Desktop connector.** A named pipe on Windows, a Unix socket on
macOS, served by the running app. Each start makes a new 32-byte token and a
new endpoint name, and writes them to a connection file in `.finance-tracker`
in the home folder. In scope: using the books without the token, a write while
**Allow changes** is off, a change that isn't journaled or can't be undone,
the relay (`resources/claude-extension/server/index.cjs`) being led to another
machine's pipe or another socket, and a connection file left readable by
other users or left behind after the connector stops.

**The update feed.** The installed app updates only from this repository's
GitHub releases (`src/main/updateFeed.ts`; the build refuses any other feed),
through electron-updater. The packaged app's Electron fuses turn off Run as
Node, `NODE_OPTIONS` and the inspector, load the app only from its asar, and
check the asar's integrity (`scripts/fuses.cjs`). In scope: getting the app to
install something that isn't a release of this repository, and getting code
into the packaged app around the fuses.

Also in scope:

- secrets sealed by the OS (the Anthropic API key, the SimpleFIN access URL,
  the Google sign-in) leaking into the database in the clear, an export, the
  log or the AI request log
- the file importers (CSV, QFX, OFX, QIF) and the documents reader, which read
  untrusted files
- the window: its content security policy, navigation, and the bridge between
  the window and the main process
- text from a bank, a file or a web page getting the AI to change the books
  in a way the user didn't ask for and can't see or undo

## Out of scope

- SimpleFIN, Anthropic, Google, GitHub and Claude Desktop themselves: report
  those to them.
- Anything that needs the user's OS account already taken over. A program
  running as the user can do what the user can, which includes opening the
  books, since the OS keystore unseals the key for that account.
- The installers not being code-signed yet (known).
- A run from source (`npm run dev`), which keeps its database unencrypted
  unless **Settings → Data → Encrypted** is on.

## Known limits

- On Windows the connector's pipe has Node's default access list: full access
  for the user, SYSTEM and administrators, and read for everyone else. Sending
  the token takes write access, so the token is the gate. Node can't set the
  pipe to refuse remote clients, so someone holding the user's network
  credentials, where Windows file sharing reaches the computer, can connect,
  and with a stolen connection file use the books until the connector is
  turned off or the app quits.
- The documents folder is an ordinary folder. The app doesn't encrypt the
  files you put there.
- Files from **Export all data** (JSON) and **Export all transactions** (CSV)
  are not encrypted.
