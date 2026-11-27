import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIR_NAME } from './build'

// The file bridge, a development tool with no authentication, is not in this
// edition: a development run starts nothing. Delete all data still clears the
// folder another build's development run may have left (wipe.ts), so
// bridgeDir stays as it is.

/** ~/.finance-tracker/bridge; a build with its own data folder has its own. */
export function bridgeDir(): string {
  return process.env['FINANCE_TRACKER_BRIDGE_DIR'] || join(homedir(), HOME_DIR_NAME, 'bridge')
}

export function startBridge(_onApplied: (actions: string[], imported: boolean) => void): void {}
