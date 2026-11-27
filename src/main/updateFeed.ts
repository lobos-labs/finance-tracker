// The update feed a build may carry (FINANCE_TRACKER_UPDATE_URL, which
// electron.vite.config.ts checks here before it becomes __UPDATE_URL__ for
// updater.ts). The open edition updates only from a repository's GitHub
// releases: https://github.com/<owner>/<repo>/releases/latest/download, where
// electron-updater's generic provider finds latest.yml and the installer the
// latest release carries. Any other feed could update it into another build
// (same app id, same data folder), so the build refuses one. Every other build
// takes its feed as before. No Electron or Node here: the config imports it.

/** GitHub's rule for an account or organization name: letters, digits and single hyphens inside, at most 39 characters. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** A repository name: letters, digits, dots, hyphens and underscores, at most 100 characters, never "." or "..". */
const REPO = /^[A-Za-z0-9._-]{1,100}$/

const FEED = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/latest\/download$/

/** The form the open edition's feed takes, for messages. */
export const GITHUB_RELEASES_FEED = 'https://github.com/<owner>/<repo>/releases/latest/download'

/** Whether a URL is exactly a repository's latest-release downloads on GitHub: no other host, path, port, query, fragment or sign-in. */
export function isGitHubReleasesFeed(url: string): boolean {
  const m = FEED.exec(url)
  if (!m) return false
  const [, owner, repo] = m
  return OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..'
}

/** Whether a build can install an update itself: everywhere but macOS, and there only when built signed with a Developer ID ('1'). */
export const selfUpdating = (platform: string, macSelfUpdate: string): boolean => platform !== 'darwin' || macSelfUpdate === '1'

/** A scheduled check that failed is tried again this soon, and at most this many times in a row. */
export const CHECK_RETRY_MS = 10 * 60_000
export const CHECK_RETRIES = 3

/**
 * How long after a scheduled check failed to try again, or null to leave it to the next scheduled check. `failures`
 * is how many have failed in a row, this one counted (0: it did not fail).
 */
export const retryAfter = (failures: number): number | null => (failures >= 1 && failures <= CHECK_RETRIES ? CHECK_RETRY_MS : null)

/** An update that still waits is mentioned again after this long. */
export const UPDATE_REMINDER_MS = 24 * 3600_000

/**
 * Whether to say now that there is an update: a downloaded one that waits to be installed, or a newer version this
 * build can't install itself. Said when it is found, and once a day while it still waits. Never while notifications
 * are held back (paused, or in quiet hours): the next look says it then. `version` is the one that waits (null:
 * none), and `told` the version last mentioned and when, in the same clock as `now` (milliseconds).
 */
export function tellsOfUpdate(o: { version: string | null; told: { version: string; at: number } | null; now: number; held: boolean }): boolean {
  if (!o.version || o.held) return false
  return o.told?.version !== o.version || o.now - o.told.at >= UPDATE_REMINDER_MS
}

/** The page a person downloads a release from: a GitHub releases feed without its /download; any other feed has none (''). */
export const releasesPage = (feed: string): string => (isGitHubReleasesFeed(feed) ? feed.replace(/\/download$/, '') : '')

/** Why a build of this edition ("open", or empty for every other build) can't carry this update feed; null when it can. */
export function updateFeedProblem(edition: string, url: string): string | null {
  if (edition !== 'open' || url === '' || isGitHubReleasesFeed(url)) return null
  return `FINANCE_TRACKER_EDITION=open updates only from GitHub releases: FINANCE_TRACKER_UPDATE_URL must be ${GITHUB_RELEASES_FEED} or empty, not "${url}"`
}
