import type { SecretStore } from './license'
import type { BankConnection, SyncResult } from '../shared/types'

// Bank sync through Plaid needs the hosted service, so it is not in this
// edition: the banks come in through SimpleFIN or a statement file
// (bankFeed.ts). Nothing is ever connected here, and connecting refuses.

const NOT_HERE = 'Bank sync through Plaid is not in this edition. Connect SimpleFIN or import a statement.'

export const isConnected = (): boolean => false
export const lastSyncAt = (): number | null => null
export const lastWarnings = (): string[] => []
export const available = (): boolean => false
export const connections = (): BankConnection[] => []

export function configureBank(_o: { installKey: SecretStore }): void {}

export async function linkUrl(_reconnect?: string): Promise<{ linkToken: string; url: string }> {
  throw new Error(NOT_HERE)
}

export function cancelLink(): void {}

export async function awaitLink(_linkToken: string, _reconnect?: string): Promise<number> {
  throw new Error(NOT_HERE)
}

export async function disconnect(_itemId: string): Promise<void> {
  throw new Error(NOT_HERE)
}

export async function disconnectAll(): Promise<void> {}

export async function sync(): Promise<SyncResult> {
  throw new Error(NOT_HERE)
}
