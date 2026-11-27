import type { ClaudeCodeStatus } from '../shared/types'

// Claude Code mode (claude -p on the user's own subscription) is not in this
// edition: the AI runs on the user's own key, or Claude Desktop reaches the
// books through the connector. These are the calls the rest of the app makes,
// with nothing to clean up and nothing installed.

export function forgetWorkDir(): void {}

export function cleanWorkDir(): void {}

export function forgetTranscripts(): void {}

export async function status(_force = false): Promise<ClaudeCodeStatus> {
  return { installed: false, loggedIn: false, account: null, method: null }
}

export function signIn(): void {
  throw new Error('Claude Code mode is not in this edition.')
}
