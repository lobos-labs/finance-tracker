import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { AccountSeal } from './dbkey'

// The database key sealed by Windows DPAPI for the signed-in account
// (CurrentUser scope), straight through .NET's ProtectedData in a one-shot
// Windows PowerShell child: the key file's `account` seal (dbkey.ts). Unlike
// Electron's safeStorage, whose AES key lives in the data folder's Local State
// file, this opens for the same Windows account whatever happened to the app:
// reinstalled (a Store uninstall deletes its data folder, not the backups in
// the documents folder), the beta beside the release, Local State lost. It
// runs only when a key file is made, unlocked another way, or missing this
// seal; the key goes in on stdin, never on the command line. No Electron here.

const ENTROPY = 'finance-tracker database key v1'

const script = (op: 'Protect' | 'Unprotect'): string =>
  [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$i=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$o=[Security.Cryptography.ProtectedData]::${op}($i,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($o))'
  ].join(';')

/** Windows PowerShell by its full path (not whatever PATH finds first). */
const powershell = (): string => join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function run(op: 'Protect' | 'Unprotect', data: Buffer): Buffer {
  const r = spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script(op)], { input: data.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (r.error) throw new Error(`DPAPI ${op.toLowerCase()} failed: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`DPAPI ${op.toLowerCase()} failed: ${(r.stderr ?? '').split(/\r?\n/)[0] || `exit ${r.status}`}`)
  const out = Buffer.from(String(r.stdout).trim(), 'base64')
  if (!out.length) throw new Error(`DPAPI ${op.toLowerCase()} returned nothing`)
  return out
}

/** DPAPI for this Windows account; null on any other platform. */
export function windowsAccountSeal(platform: NodeJS.Platform = process.platform): AccountSeal | null {
  if (platform !== 'win32') return null
  return { seal: (data) => run('Protect', data), open: (blob) => run('Unprotect', blob) }
}
