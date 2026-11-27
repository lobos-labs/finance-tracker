import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CHECK_RETRIES, CHECK_RETRY_MS, GITHUB_RELEASES_FEED, isGitHubReleasesFeed, UPDATE_REMINDER_MS, releasesPage, retryAfter, selfUpdating, tellsOfUpdate, updateFeedProblem } from '../src/main/updateFeed.ts'

// The update feed a build may carry (electron.vite.config.ts checks it with
// updateFeedProblem): the open edition takes only a repository's GitHub
// releases, https://github.com/<owner>/<repo>/releases/latest/download, or
// none; every other build takes its feed as before.

const FEED = 'https://github.com/example-org/finance-app/releases/latest/download'

describe('the open edition\'s update feed', () => {
  test('a repository\'s latest-release downloads on GitHub, or none', () => {
    for (const url of [FEED, 'https://github.com/a/b/releases/latest/download', 'https://github.com/Org-9/app.desktop_v2/releases/latest/download', `https://github.com/${'o'.repeat(39)}/${'r'.repeat(100)}/releases/latest/download`]) {
      assert.equal(isGitHubReleasesFeed(url), true, url)
      assert.equal(updateFeedProblem('open', url), null, url)
    }
    assert.equal(updateFeedProblem('open', ''), null)
  })

  test('any other address is refused, and the message says the form', () => {
    const refused = [
      // another host: the paid build's own feed, a look-alike, GitHub's API or its asset host
      'https://updates.example.com/desktop',
      'https://github.com.example.com/example-org/finance-app/releases/latest/download',
      'https://api.github.com/repos/example-org/finance-app/releases/latest',
      'https://objects.githubusercontent.com/example-org/finance-app/releases/latest/download',
      'https://www.github.com/example-org/finance-app/releases/latest/download',
      // not https, a port, a sign-in, a query, a fragment, a trailing slash, spaces around it
      'http://github.com/example-org/finance-app/releases/latest/download',
      'https://github.com:443/example-org/finance-app/releases/latest/download',
      'https://user:pass@github.com/example-org/finance-app/releases/latest/download',
      `${FEED}?x=1`,
      `${FEED}#latest`,
      `${FEED}/`,
      ` ${FEED}`,
      `${FEED}\n`,
      // another path: one release's tag, the releases page, a file, the repository, a missing or extra part
      'https://github.com/example-org/finance-app/releases/download/v1.0.0',
      'https://github.com/example-org/finance-app/releases/latest',
      'https://github.com/example-org/finance-app/releases/latest/download/latest.yml',
      'https://github.com/example-org/finance-app',
      'https://github.com/example-org/releases/latest/download',
      'https://github.com/example-org/finance-app/extra/releases/latest/download',
      'https://github.com/example-org/finance-app/releases/Latest/download',
      // names GitHub doesn't allow
      'https://github.com/-org/finance-app/releases/latest/download',
      'https://github.com/org-/finance-app/releases/latest/download',
      'https://github.com/my--org/finance-app/releases/latest/download',
      'https://github.com/my_org/finance-app/releases/latest/download',
      `https://github.com/${'o'.repeat(40)}/finance-app/releases/latest/download`,
      `https://github.com/example-org/${'r'.repeat(101)}/releases/latest/download`,
      'https://github.com/example-org/./releases/latest/download',
      'https://github.com/example-org/../releases/latest/download',
      'https://github.com/example-org/finance%20app/releases/latest/download',
      'https://github.com/example-org/finance app/releases/latest/download'
    ]
    for (const url of refused) {
      assert.equal(isGitHubReleasesFeed(url), false, url)
      const problem = updateFeedProblem('open', url)
      assert.ok(problem, url)
      assert.ok(problem.includes(GITHUB_RELEASES_FEED), url)
      assert.ok(problem.includes('FINANCE_TRACKER_UPDATE_URL'), url)
    }
  })

  test('every other build takes its feed as before, GitHub or not', () => {
    for (const url of ['', 'https://updates.example.com/desktop', 'http://localhost:8080/feed', FEED]) assert.equal(updateFeedProblem('', url), null, url)
  })

  test('a person downloads a release from the page behind the feed, and another feed has no page', () => {
    assert.equal(releasesPage(FEED), 'https://github.com/example-org/finance-app/releases/latest')
    for (const url of ['', 'https://updates.example.com/desktop/download', 'http://localhost:8080/feed']) assert.equal(releasesPage(url), '', url)
  })

  test('a build installs its own updates everywhere but on macOS, and there only when signed with a Developer ID', () => {
    assert.equal(selfUpdating('win32', ''), true)
    assert.equal(selfUpdating('linux', ''), true)
    assert.equal(selfUpdating('darwin', ''), false)
    assert.equal(selfUpdating('darwin', '0'), false)
    assert.equal(selfUpdating('darwin', '1'), true)
  })
})

describe('a scheduled check that failed', () => {
  test('is tried again ten minutes later, three times in a row at most, and then left to the next scheduled check', () => {
    assert.equal(CHECK_RETRY_MS, 10 * 60_000)
    assert.equal(CHECK_RETRIES, 3)
    assert.equal(retryAfter(0), null)
    for (const failures of [1, 2, 3]) assert.equal(retryAfter(failures), CHECK_RETRY_MS, String(failures))
    for (const failures of [4, 5, 40]) assert.equal(retryAfter(failures), null, String(failures))
  })
})

// The same rule serves both kinds of news: an update that has downloaded and waits to be installed, and a newer
// version a build can't install itself (updater.ts hands background.ts the version of whichever there is).
describe('saying that there is an update', () => {
  const AT = 1_800_000_000_000
  const DAY = 24 * 3600_000

  test('it is said when the update arrives, and nothing is said while none waits', () => {
    assert.equal(tellsOfUpdate({ version: '0.1.1', told: null, now: AT, held: false }), true)
    assert.equal(tellsOfUpdate({ version: null, told: null, now: AT, held: false }), false)
    assert.equal(tellsOfUpdate({ version: null, told: { version: '0.1.1', at: AT - 2 * DAY }, now: AT, held: false }), false)
  })

  test('while it waits it is said once a day, not at every look', () => {
    assert.equal(UPDATE_REMINDER_MS, DAY)
    const told = { version: '0.1.1', at: AT }
    for (const later of [0, 1, 3600_000, DAY - 1]) assert.equal(tellsOfUpdate({ version: '0.1.1', told, now: AT + later, held: false }), false, String(later))
    for (const later of [DAY, DAY + 1, 9 * DAY]) assert.equal(tellsOfUpdate({ version: '0.1.1', told, now: AT + later, held: false }), true, String(later))
  })

  test('another version is said at once, whenever the last one was mentioned', () => {
    assert.equal(tellsOfUpdate({ version: '0.1.2', told: { version: '0.1.1', at: AT }, now: AT + 1, held: false }), true)
  })

  test('paused notifications and quiet hours hold it back, and the next look says it', () => {
    assert.equal(tellsOfUpdate({ version: '0.1.1', told: null, now: AT, held: true }), false)
    assert.equal(tellsOfUpdate({ version: '0.1.1', told: { version: '0.1.1', at: AT - 3 * DAY }, now: AT, held: true }), false)
    // Nothing was noted while it was held, so the look after says it.
    assert.equal(tellsOfUpdate({ version: '0.1.1', told: null, now: AT + 3600_000, held: false }), true)
  })
})
