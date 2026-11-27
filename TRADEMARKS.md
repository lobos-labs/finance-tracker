# Trademarks

"Lobos Labs" and this app's logo and icon are trademarks of Lobos Labs, Inc.
"Finance Tracker" is a working name until the app's own name is chosen. The
code's license covers the code; it doesn't grant any right to the names, logo or
icon.

## What you can do

- Say what the project is called, link to it, and write about it.
- Say that your fork or your work is based on this project, or works with it.
- Share unmodified releases from this repository under their own name.

## Forks must rename

A modified version you distribute, as source or as an app, needs its own name
and its own icon, and mustn't suggest that Lobos Labs made, checked or
endorses it. In this code that means at least:

- `APP_NAME` in `src/shared/app.ts`, `productName` in `package.json` and
  `electron-builder.yml`, the icons in `resources/`, and the logo drawn in the
  window (`Logo` in `src/renderer/src/PageHeader.tsx`)
- `EXTENSION_AUTHOR` in `src/main/mcpb.ts`, the publisher the Claude Desktop
  extension names
- `appId` in `electron-builder.yml` and `APP_ID` in `src/main/build.ts`, so
  your app doesn't install over this one or take its updates
- `DATA_DIR_NAME` in `src/main/build.ts`, so your app keeps its own data
  folder and never opens the books of an installed copy of this app
- the update feed: build with your own repository's releases in
  `FINANCE_TRACKER_UPDATE_URL`, or none

## Other marks

Claude is a trademark of Anthropic, PBC. SimpleFIN, Google, Google Calendar,
GitHub, Windows and macOS are trademarks of their owners. This app is not
affiliated with or endorsed by any of them.

Questions about the name: open an issue.
