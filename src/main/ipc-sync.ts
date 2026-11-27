import type { SyncStatusView } from '../shared/types'

// Phone sync is not in this edition. Settings → Devices never shows, since
// getSyncStatus reports no relay, no viewer and no pairing, and the other
// channels refuse. The calls index.ts, ipc.ts and wipe.ts make are here with
// nothing to do.

type Handle = (channel: string, fn: (...args: never[]) => unknown) => void
type Broadcast = (channel: string, payload?: unknown) => void

const NOT_HERE = 'Phone sync is not in this edition.'

const notPaired = (): SyncStatusView => ({
  paired: false,
  desktopCode: null,
  relayUrl: null,
  relayFrom: null,
  viewerUrl: null,
  viewerFrom: null,
  urlsEditable: false,
  lastPublishedAt: null,
  lastBytes: null,
  lastCommand: null,
  lastError: null,
  running: false
})

export function registerSyncIpc(handle: Handle, _send: Broadcast): void {
  handle('getSyncStatus', notPaired)
  for (const channel of ['listSyncDevices', 'removeSyncDevice', 'resetSync', 'setRelayUrl', 'setViewerUrl', 'startPairing', 'copySyncPairing', 'approveSyncDevice', 'syncNow']) {
    handle(channel, () => {
      throw new Error(NOT_HERE)
    })
  }
}

export function startSync(): void {}

export function syncDataChanged(): void {}

export const syncPaired = (): boolean => false

export async function forgetSync(): Promise<void> {}

/** Before a restore swaps the database: there are no sync rows to keep. */
export async function holdSync(): Promise<Array<{ key: string; value: string }>> {
  return []
}

export function releaseSync(_rows: Array<{ key: string; value: string }> | null): void {}
