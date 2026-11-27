# Privacy

Finance Tracker has no account and no server. Your books stay on your computer, in an
encrypted file. Lobos Labs, Inc. receives nothing from the app.

This file describes this repository's code and the releases built from it. A
modified copy built by someone else can behave differently.

## No telemetry

The app has no telemetry, analytics, crash reporting or usage tracking, and no
library that does any of those. (The Anthropic SDK brings OpenTelemetry's
interface package with it. Nothing that sends telemetry is installed beside
it, so it does nothing.) Its window can't load anything from the
internet (its content security policy allows only the app's own files), so the
only network requests are the ones in the table below, made by the app's main
process. Links you click (help pages, SimpleFIN's site) open in your own
browser.

The app's log (`logs` in the data folder) records events and errors and stays
on your computer. It is written to hold nothing from your books: a failed
action is logged by its kind, not by its message, which could name an account
or an asset. **Settings → Data → Copy diagnostics** puts the app's version,
your system, the app's folders and the log's tail on your clipboard; it goes
wherever you paste it, and nowhere else. A folder path in it can carry your
user name. **Report** on an AI answer copies the answer to your clipboard; it
goes nowhere unless you paste it somewhere.

## What leaves your computer

| Where | What | When |
|---|---|---|
| Anthropic, on your API key | What each AI feature sends (below), your API key, and the Anthropic SDK's standard headers: the SDK's version, your operating system, processor type and runtime version | Only with the AI on and a key saved |
| Anthropic's web search | The search terms the model writes | Review (up to 5 searches per request, and answering one message can take several requests) and Values |
| Claude Desktop, then Anthropic under your Claude account | What each tool Claude calls returns | Only while **Connector** is on and the app is open |
| Your SimpleFIN bridge | The setup token, claimed once for an access URL; then requests for your accounts and their transactions over date ranges, signed with that URL's credentials | When you connect, each sync, and **Sync now** |
| Google, with your own OAuth client | The sign-in (in your browser); each calendar item's title, date, time and amount, and a fixed note naming the app's calendar; to-do reminders to Google Tasks if you turn that on. Check-offs and new dates come back. Disconnecting revokes the sign-in | Only if you connect Google Calendar: then when the app starts, every hour while it's open, after each bank sync, a few seconds after a calendar item changes or after the AI or Claude Desktop changes your books, and when you press **Sync now** |
| GitHub | A request for this repository's latest release and, when there's a new one, its installer (a Mac build without a Developer ID downloads none: it only says a new version is out). The updater (electron-updater) adds a random ID it makes once per install and keeps in `.updaterId` in the data folder, which it uses for staged rollouts | The installed app: 30 seconds after it starts, every 6 hours, and **Check for updates**. A build from source checks only if it was built with an update feed |
| Lobos Labs | Nothing | Never |

Each of these services handles what it receives under its own terms and
privacy policy: [Anthropic](https://www.anthropic.com/legal/privacy),
[SimpleFIN Bridge](https://beta-bridge.simplefin.org),
[Google](https://policies.google.com/privacy) and
[GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
Through Claude Desktop, your Claude account's own terms and settings apply.

## What each AI feature sends

**Settings → AI → What's sent** shows this same list, and the request log
under it keeps each request as it went out, with each tool's definition kept
by name and each PDF or picture by name and size (a text file's pages are kept
as text).

- **Categorize**
  - up to 40 transactions at a time that no rule or earlier answer covers
  - each one's description, with runs of four or more digits taken out
  - its signed amount
  - the kind of account it's in (cash, credit card, loan), not the account's name
  - your category names, kinds and hints
  - up to 80 of your rules, as examples
  - your remembered facts
- **Headline**
  - today's date and how many months of history there are
  - this month's spending and income by category, and your usual pace by this day
  - the last three months' spending and income
  - this month's largest purchases, new merchants and most frequent merchants, leaving out hidden vendors
  - recurring charges, and bills due in the next 10 days
  - net worth and its 30, 90 and 365-day change
  - what's owed on each card and loan, by account name, and a payoff plan
  - the investment total and its 30-day change
  - accounts whose bank feed is behind, by name
  - trips within six weeks of today
  - how many of this month's transactions are uncategorized
  - your remembered facts
  - the last few headlines
- **Review**
  - your messages, and the names of files you attach
  - today's date, your category names, your ventures' names, kinds and residence dates, and your remembered facts
  - what its tools look up as it works: open items, transactions with their notes and tags, spending totals, recurring items, accounts with their names and balances, assets and loans, investments, taxes, benefits, insurance, credit, trips, habits, goals and calendar entries
  - the names of files in the documents folder, not their full paths
  - web searches the model runs, up to 5 per request; answering one message can take several requests
- **Values**
  - the asset's name and kind, where it is or who holds it, and its notes (an address, mileage or VIN, say)
  - when it was bought and for how much, and its last six values
  - web searches: only home-value sites for a house, only listing sites for a vehicle, and the whole web for any other asset you look up
- **Documents**
  - a file the assistant opens: a PDF as a document, a picture as an image, a text file in pages of 12,000 characters
  - its name in the documents folder
- **Key check**
  - the word "Hi" to Claude Haiku 5.5, for one output token

Web searches are run by Anthropic, so the search terms the model writes go
through Anthropic's search. A value lookup searches only home-value sites for a
house and only car-listing sites for a vehicle; those two are also looked up
about once a month on their own. **Update value** on any other asset searches
the whole web, and the model writes its search terms from that asset's name
and notes.

## What stays on your computer

| What | Where |
|---|---|
| The books: accounts, transactions, categories, rules, notes, closed months, goals, records | `finance.db` in the data folder, encrypted |
| The key that opens them | `finance.key` beside it, sealed by the OS and by your recovery code |
| Automatic backups, and a copy of the key file | `backups` in the data folder, encrypted |
| Your API key, the SimpleFIN access URL, the Google sign-in | inside the books, each sealed by the OS for your user account |
| The AI request log: every request as it went out (tool definitions by name, PDFs and pictures by name and size only, a text file's pages as text) and how it ended, as the token counts the service reported or the error | inside the books; the newest 500 requests, none older than 30 days. **Settings → AI → Request log** turns it off or clears it |
| The app's log | `logs` in the data folder |
| Statements, paystubs, receipts and files you attach in Review | the documents folder, an ordinary folder the app doesn't encrypt; a service that syncs your Documents folder takes it too (below) |
| The connector's address and token, while **Connector** is on | `connector.json` in `.finance-tracker` in your home folder; deleted when the connector stops or the app quits |

The data folder is `%APPDATA%\Finance Tracker\` on Windows and
`~/Library/Application Support/Finance Tracker/` on macOS. **Export all data**
and **Export all transactions** write files you choose, which are not
encrypted; the export leaves out your secrets and the AI request log.

The documents folder starts as `Finance Tracker` in your Documents folder. If
OneDrive backs up Documents on Windows, or iCloud Drive syncs Desktop &
Documents on a Mac, that service uploads it, with the copies the app saves
there (dropped files, receipts, files attached in Review). The app sends them
nowhere itself. To keep them on this computer only, choose a folder outside
the synced ones on setup's first step or in **Settings → Data**; files already
in the old folder stay there until you move them. The data folder is outside
what those two sync.

## Deleting it

**Settings → Data → Delete all data** removes the books, their key file, the
backups, the app's log and the files you attached in Review. It lists what it
will remove first. Where they were connected, it revokes the Google sign-in
and opens your SimpleFIN bridge's site for you to end the app's access there.
Then it quits. The documents folder holds your own files, so it's removed only
if you confirm that separately.

It leaves what isn't your books: Electron's own settings files in the data
folder (the updater's random ID among them); an update's downloaded installer,
in the updater's own cache folder; on a Mac, the Keychain item `Finance
Tracker Safe Storage`; the Claude Desktop extension if you installed it (in
`.finance-tracker` in your home folder, and in Claude Desktop); the calendar,
and the task list if you used Google Tasks, that the app made in your Google
account; and any file you exported. Uninstalling the app keeps the data
folder, so a reinstall finds your books.

To stop sending to a service: turn off **AI** in **Settings → AI**, turn off
**Connector** in **Settings → Claude Desktop**, disconnect SimpleFIN on
**Accounts**, or disconnect Google Calendar on **Calendar**. The check for a
new version has no switch: an installed app asks GitHub for the latest
release as the table says; a build from source with no update feed never
does.
