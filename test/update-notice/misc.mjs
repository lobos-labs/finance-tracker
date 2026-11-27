// The login item (ipc-alerts.ts), the build's facts (build.ts) and the bank feed (bankFeed.ts, simplefin.ts),
// as src/main/background.ts uses them: no bank is connected.

export const applyLoginItem = () => {}
export const appUserModelId = () => 'test.app'
export const connected = () => false
export const lastSyncAt = () => null
export const historyPending = () => false
export const migrateDeepPull = () => {}
