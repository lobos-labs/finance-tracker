import { safeStorage } from 'electron'
import { getSetting, setSetting } from './db'

// Secrets are encrypted with the OS keystore (DPAPI on Windows, Keychain on
// macOS) before they touch the database, so a copied finance.db is useless
// without this Windows user account.

export type SecretName = 'anthropicApiKey' | 'licenseToken' | 'licenseKey' | 'freeToken' | 'bankInstallKey' | 'simplefinAccessUrl' | 'googleClientSecret' | 'googleRefreshToken' | 'syncVaultKey' | 'syncDeviceKey'

export function saveSecret(name: SecretName, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; refusing to store secrets in plain text.')
  // On Linux without a keyring, "encryption" is a hardcoded password: as good as plain text.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('No keyring is available (GNOME Keyring or KWallet); refusing to store secrets in plain text.')
  setSetting(`secret.${name}`, safeStorage.encryptString(value).toString('base64'))
}

export function readSecret(name: SecretName): string | null {
  const stored = getSetting(`secret.${name}`)
  if (!stored) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    // A database restored from another Windows account: the pages show it as not connected.
    console.warn(`[secrets] ${name} can't be decrypted on this account`)
    return null
  }
}

export function deleteSecret(name: SecretName): void {
  setSetting(`secret.${name}`, null)
}

export function hasSecret(name: SecretName): boolean {
  return getSetting(`secret.${name}`) !== null
}
