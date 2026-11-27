import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// scripts/dist-open.cjs, the open edition's release build: how it decides to sign from the
// environment, what it lays over electron-builder.yml, and how it reads the feed files; and how
// scripts/sign-win.cjs, its Windows sign hook, picks a signer and reads a PE file's signature table.
// Nothing here builds or signs.

const require = createRequire(import.meta.url)
const { signingPlan, builderConfig, feedEntries, macSelfUpdate } = require('../scripts/dist-open.cjs') as {
  macSelfUpdate: (plan: { platform: string; sign: string }) => boolean
  signingPlan: (platform: string, from: Record<string, string>) => { platform: string; sign: string; notarize: boolean; problems: string[] }
  builderConfig: (plan: { platform: string; sign: string; notarize: boolean }, feed: string, o?: { dlls?: string[]; from?: Record<string, string> }) => Record<string, any>
  feedEntries: (text: string) => Array<{ url: string; sha512: string; size: number }>
}

const FEED = 'https://github.com/someone/something/releases/latest/download'
const PUBLISHER = { WIN_SIGN_PUBLISHER: 'Lobos Labs, Inc.' }
const CERTUM = { CERTUM_EMAIL: 'signing@example.com', CERTUM_OTP: 'otpauth://totp/x?secret=ABC' }
// Any file that exists stands in for a .pfx: the plan checks only that it is there.
const PFX = { WIN_SIGN_PFX: join(import.meta.dirname, 'dist-open.test.ts'), WIN_SIGN_PFX_PASSWORD: 'pw' }
const NOTARY = { APPLE_API_KEY: '/tmp/AuthKey.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'issuer' }

describe('dist:open signing plan', () => {
  test('Windows with nothing set: unsigned', () => {
    assert.deepEqual(signingPlan('win32', {}), { platform: 'win32', sign: 'none', notarize: false, problems: [] })
  })

  test('Windows signs with ssign from the Certum settings, or with signtool from a .pfx', () => {
    assert.deepEqual(signingPlan('win32', { ...CERTUM, ...PUBLISHER }), { platform: 'win32', sign: 'ssign', notarize: false, problems: [] })
    assert.deepEqual(signingPlan('win32', { CERTUM_EMAIL: 'signing@example.com', CERTUM_TOKEN: '123456', ...PUBLISHER }).problems, [])
    assert.deepEqual(signingPlan('win32', { ...PFX, ...PUBLISHER }), { platform: 'win32', sign: 'signtool', notarize: false, problems: [] })
  })

  test('Windows signing half set is refused rather than built unsigned', () => {
    const problems = (from: Record<string, string>): string => signingPlan('win32', from).problems.join('\n')
    assert.match(problems({ CERTUM_OTP: 'seed', ...PUBLISHER }), /needs CERTUM_EMAIL/)
    assert.match(problems({ CERTUM_EMAIL: 'signing@example.com', ...PUBLISHER }), /CERTUM_OTP .* or CERTUM_TOKEN/)
    assert.match(problems({ ...CERTUM, CERTUM_TOKEN: '123456', ...PUBLISHER }), /one of them/)
    assert.match(problems(CERTUM), /needs WIN_SIGN_PUBLISHER/)
    assert.match(problems({ ...CERTUM, ...PFX, ...PUBLISHER }), /two signers/)
    assert.match(problems({ WIN_SIGN_PFX: 'C:\\nowhere\\signing.pfx', ...PUBLISHER }), /doesn't exist/)
    assert.match(problems({ WIN_SIGN_PFX_PASSWORD: 'pw', ...PUBLISHER }), /without WIN_SIGN_PFX/)
    assert.match(problems(PUBLISHER), /no signer is/)
  })

  test('macOS with no certificate: ad hoc, not notarized', () => {
    assert.deepEqual(signingPlan('darwin', {}), { platform: 'darwin', sign: 'ad-hoc', notarize: false, problems: [] })
  })

  test('macOS with the certificate signs; with the API key too it notarizes', () => {
    assert.deepEqual(signingPlan('darwin', { CSC_LINK: '/tmp/id.p12', CSC_KEY_PASSWORD: 'pw' }), { platform: 'darwin', sign: 'developer-id', notarize: false, problems: [] })
    assert.deepEqual(signingPlan('darwin', { CSC_LINK: '/tmp/id.p12', ...NOTARY }), { platform: 'darwin', sign: 'developer-id', notarize: true, problems: [] })
  })

  test('macOS notarizing without a certificate, a partial API key or an Apple ID is refused', () => {
    assert.match(signingPlan('darwin', NOTARY).problems.join('\n'), /needs the Developer ID certificate/)
    assert.match(signingPlan('darwin', { CSC_LINK: 'x', APPLE_API_KEY: 'k' }).problems.join('\n'), /missing APPLE_API_KEY_ID, APPLE_API_ISSUER/)
    assert.match(signingPlan('darwin', { CSC_LINK: 'x', APPLE_ID: 'me@example.com' }).problems.join('\n'), /App Store Connect API key/)
  })

  test('empty values count as not set (an unset GitHub secret comes through empty)', () => {
    assert.equal(signingPlan('darwin', { CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_API_KEY_ID: ' ' }).sign, 'ad-hoc')
    assert.deepEqual(signingPlan('darwin', { CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_API_KEY_ID: '' }).problems, [])
  })

  test('only a Mac build signed with a Developer ID is compiled to install its own updates: macOS installs none for an ad hoc signature', () => {
    assert.equal(macSelfUpdate(signingPlan('darwin', {})), false)
    assert.equal(macSelfUpdate(signingPlan('darwin', { CSC_LINK: '/tmp/id.p12', CSC_KEY_PASSWORD: 'pw' })), true)
    assert.equal(macSelfUpdate(signingPlan('darwin', { CSC_LINK: '/tmp/id.p12', ...NOTARY })), true)
    // Windows builds install their own whatever the signing: the flag is a Mac build's alone.
    assert.equal(macSelfUpdate(signingPlan('win32', { ...CERTUM, ...PUBLISHER })), false)
    const script = readFileSync(join(import.meta.dirname, '..', 'scripts', 'dist-open.cjs'), 'utf8')
    assert.match(script, /FINANCE_TRACKER_MAC_SELF_UPDATE: selfUpdate \? '1' : ''/)
    assert.match(script, /compileForEachArch\(feed, macSelfUpdate\(plan\)\)/)
  })

  test('another platform is refused', () => {
    assert.equal(signingPlan('linux', {}).problems.length, 1)
  })
})

describe('dist:open builder config', () => {
  test('a generic feed at the GitHub URL, one channel, asset names without spaces', () => {
    const c = builderConfig(signingPlan('win32', {}), FEED)
    assert.deepEqual(c['publish'], { provider: 'generic', url: FEED })
    assert.equal(c['detectUpdateChannel'], false)
    for (const name of [c['win'].artifactName, c['mac'].artifactName, c['dmg'].artifactName]) assert.doesNotMatch(name, /\s/)
    assert.equal(c['forceCodeSigning'], undefined)
    assert.equal(c['win'].signtoolOptions, undefined)
  })

  test('Windows signing: every file once through the hook, SHA-256, the unsigned DLLs, the publisher for the updater, no build without a signature', () => {
    const from = { ...CERTUM, ...PUBLISHER }
    const c = builderConfig(signingPlan('win32', from), FEED, { dlls: ['ffmpeg.dll'], from })
    assert.equal(c['forceCodeSigning'], true)
    assert.deepEqual(c['win'].signExts, ['ffmpeg.dll'])
    assert.match(c['win'].signtoolOptions.sign, /scripts[\\/]sign-win\.cjs$/)
    assert.deepEqual(c['win'].signtoolOptions.signingHashAlgorithms, ['sha256'])
    assert.deepEqual(c['win'].signtoolOptions.publisherName, ['Lobos Labs, Inc.'])
  })

  test('macOS ad hoc: identity "-" without the hardened runtime, never notarized', () => {
    const c = builderConfig(signingPlan('darwin', {}), FEED)
    assert.equal(c['mac'].identity, '-')
    assert.equal(c['mac'].hardenedRuntime, false)
    assert.equal(c['mac'].notarize, false)
  })

  test('macOS Developer ID: the certificate finds the identity, the hardened runtime stays, notarized as planned', () => {
    const signed = builderConfig(signingPlan('darwin', { CSC_LINK: 'x', ...NOTARY }), FEED)
    assert.equal(signed['mac'].identity, undefined)
    assert.equal(signed['mac'].hardenedRuntime, undefined)
    assert.equal(signed['mac'].notarize, true)
    assert.equal(signed['forceCodeSigning'], true)
  })
})

test('the feed file: every file it names, with its SHA-512 and size', () => {
  const yml = [
    'version: 1.2.3',
    'files:',
    '  - url: app-1.2.3-arm64.zip',
    '    sha512: abc==',
    '    size: 10',
    '  - url: app-1.2.3-arm64.dmg',
    '    sha512: def==',
    '    size: 20',
    'path: app-1.2.3-arm64.zip',
    'sha512: abc==',
    "releaseDate: '2026-11-12T00:00:00.000Z'",
    ''
  ].join('\n')
  assert.deepEqual(feedEntries(yml), [
    { url: 'app-1.2.3-arm64.zip', sha512: 'abc==', size: 10 },
    { url: 'app-1.2.3-arm64.dmg', sha512: 'def==', size: 20 }
  ])
})

describe('the Windows sign hook', () => {
  const hook = require('../scripts/sign-win.cjs') as {
    command: (kind: string, file: string, name: string) => { cmd: string; args: string[] }
    certificateTableSize: (file: string) => number
  }

  test('ssign takes the secrets from the environment, never the command line', () => {
    const { cmd, args } = hook.command('ssign', 'C:\\app\\Finance Tracker.exe', 'Finance Tracker')
    assert.equal(cmd, 'ssign')
    assert.deepEqual(args, ['-n', 'Finance Tracker', 'C:\\app\\Finance Tracker.exe'])
  })

  test('a file that is not a PE file is refused before anything signs it', () => {
    assert.throws(() => hook.certificateTableSize(join(import.meta.dirname, 'dist-open.test.ts')), /not a PE file/)
  })

  test("Node.js's own executable, which is signed, has a certificate table", { skip: process.platform !== 'win32' && 'PE files on Windows only' }, () => {
    assert.ok(hook.certificateTableSize(process.execPath) > 0, 'node.exe is signed')
  })
})
