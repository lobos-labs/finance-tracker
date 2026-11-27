// npm run dist:open: the open edition's release build for this computer's platform, as the public
// repository's release workflow makes it from a tag (and the private repository's
// .github/workflows/open-release-test.yml checks it). Windows: the NSIS installer, x64. macOS: a dmg
// and a zip for arm64 and for x64 (electron-builder.yml). Beside them in dist/: a .blockmap for each,
// and latest.yml or latest-mac.yml, the update feed's index, which electron-updater reads from
// FINANCE_TRACKER_UPDATE_URL (the repository's .../releases/latest/download, src/main/updateFeed.ts).
// Asset names carry no spaces, which GitHub would turn into dots and so break the feed.
//
// Signing happens only when its settings are there, and settings half there fail the build:
//   Windows  scripts/sign-win.cjs, electron-builder's sign hook, through one of two signers: Certum's
//            SimplySign cloud certificate with ssign (CERTUM_EMAIL, and CERTUM_OTP or CERTUM_TOKEN; ssign
//            on the PATH or in SSIGN), or a .pfx with signtool (WIN_SIGN_PFX, WIN_SIGN_PFX_PASSWORD).
//            WIN_SIGN_PUBLISHER is the name the certificate is issued to, which every signature is
//            checked against and which the app's updater requires of an update's installer.
//   macOS    a Developer ID Application certificate: CSC_LINK (a .p12, as base64 or a path) and
//            CSC_KEY_PASSWORD, under the hardened runtime. Notarized when APPLE_API_KEY (a .p8 file's
//            path), APPLE_API_KEY_ID and APPLE_API_ISSUER are set too.
// Without them the build is unsigned; on macOS it is signed ad hoc (Apple silicon runs nothing
// unsigned), without the hardened runtime, whose library check needs a team. An ad hoc Mac app can't
// install an update (macOS installs one only for a Developer ID signature), so it is compiled to
// check and say a new version is out; a Developer ID build installs its own. The main process is V8
// bytecode, which holds only on the arch it was compiled on, so on macOS out/ is compiled for each
// arch with that arch's Electron as it is packed (x64 under Rosetta on Apple silicon). After the build every
// packed app's fuses and SQLite driver binary are read back, each feed file is checked against the
// files it names, and dist/release-<platform>.json records what was made and how it was signed, for
// the release notes. --check stops after the settings check.
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const env = (name, from = process.env) => (from[name] ?? '').trim()

/** Prints the lines and ends the run. */
function fail(...lines) {
  console.error(['', ...lines, ''].join('\n'))
  process.exit(1)
}

const SIGN_HOOK = path.join(__dirname, 'sign-win.cjs')
const NOTARY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
const NOTARY_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

/**
 * How this build signs, from the environment: { platform, sign: 'ssign' | 'signtool' | 'developer-id' | 'ad-hoc' |
 * 'none', notarize, problems }. `problems` names what is half set; a build with any refuses to run.
 */
function signingPlan(platform, from = process.env) {
  const problems = []
  const some = (names) => names.filter((n) => env(n, from))
  const missing = (names) => names.filter((n) => !env(n, from))
  if (platform === 'win32') {
    const certum = some(['CERTUM_EMAIL', 'CERTUM_OTP', 'CERTUM_TOKEN'])
    const pfx = some(['WIN_SIGN_PFX', 'WIN_SIGN_PFX_PASSWORD'])
    if (!certum.length && !pfx.length) {
      if (env('WIN_SIGN_PUBLISHER', from)) problems.push('WIN_SIGN_PUBLISHER is set, but no signer is (CERTUM_EMAIL or WIN_SIGN_PFX)')
      return { platform, sign: 'none', notarize: false, problems }
    }
    if (certum.length && pfx.length) problems.push(`two signers are set: ${[...certum, ...pfx].join(', ')}; keep the Certum or the .pfx settings, not both`)
    const sign = certum.length ? 'ssign' : 'signtool'
    if (sign === 'ssign') {
      if (!env('CERTUM_EMAIL', from)) problems.push('signing with ssign needs CERTUM_EMAIL, the SimplySign account')
      const codes = some(['CERTUM_OTP', 'CERTUM_TOKEN'])
      if (codes.length !== 1) problems.push('signing with ssign needs CERTUM_OTP (the TOTP seed or its otpauth:// URI) or CERTUM_TOKEN (a current code), one of them')
    } else {
      const file = env('WIN_SIGN_PFX', from)
      if (!file) problems.push('WIN_SIGN_PFX_PASSWORD is set without WIN_SIGN_PFX, the .pfx file')
      else if (!existsSync(file)) problems.push(`WIN_SIGN_PFX is ${file}, which doesn't exist`)
    }
    if (!env('WIN_SIGN_PUBLISHER', from)) problems.push("signing needs WIN_SIGN_PUBLISHER, the name the certificate is issued to (its subject's CN)")
    return { platform, sign, notarize: false, problems }
  }
  if (platform === 'darwin') {
    const cert = !!env('CSC_LINK', from)
    const notary = some(NOTARY)
    const notaryId = some(NOTARY_ID)
    if (notary.length && notary.length < NOTARY.length) problems.push(`notarizing needs all of ${NOTARY.join(', ')}; missing ${missing(NOTARY).join(', ')}`)
    if (notaryId.length) problems.push(`notarizing here takes an App Store Connect API key (${NOTARY.join(', ')}), not ${notaryId.join(', ')}`)
    if (notary.length && !cert) problems.push('notarizing needs the Developer ID certificate in CSC_LINK: Apple notarizes only signed apps')
    if (!cert && env('CSC_KEY_PASSWORD', from)) problems.push('CSC_KEY_PASSWORD is set without CSC_LINK')
    return { platform, sign: cert ? 'developer-id' : 'ad-hoc', notarize: cert && notary.length === NOTARY.length, problems }
  }
  return { platform, sign: 'none', notarize: false, problems: [`the open edition is built on Windows and macOS, not ${platform}`] }
}

/** macOS installs an update only for an app signed with a Developer ID: such a build is compiled to install its own (src/main/updater.ts). */
const macSelfUpdate = (plan) => plan.platform === 'darwin' && plan.sign === 'developer-id'

/** The release's asset names: no spaces (GitHub turns them into dots, and latest.yml would name files that aren't there). */
const NAMES = { win: { artifactName: '${name}-Setup-${version}.${ext}' }, mac: { artifactName: '${name}-${version}-${arch}.${ext}' }, dmg: { artifactName: '${name}-${version}-${arch}.${ext}' } }

/** What is laid over electron-builder.yml for this build: the feed, the asset names, and signing as planned. */
function builderConfig(plan, feed, { dlls = [], from = process.env } = {}) {
  const config = {
    // A generic feed at the GitHub releases URL makes electron-builder write latest.yml / latest-mac.yml
    // (publish: null writes none). Nothing is published from here: the workflow uploads the files.
    // One channel whatever the version says: the app asks for latest.yml (updater.ts sets no channel),
    // and a version like 0.1.0-beta.5 would otherwise get beta.yml instead.
    publish: { provider: 'generic', url: feed },
    detectUpdateChannel: false,
    win: { ...NAMES.win },
    mac: { ...NAMES.mac },
    dmg: { ...NAMES.dmg }
  }
  if (plan.sign === 'ssign' || plan.sign === 'signtool') {
    config.forceCodeSigning = true
    config.win = {
      ...config.win,
      // .exe files are always signed; electron-builder.yml adds .node, and these the DLLs Electron ships unsigned.
      signExts: dlls,
      signtoolOptions: {
        // Every file through the hook, once: SHA-256 only (ssign refuses to sign a file twice).
        sign: SIGN_HOOK,
        signingHashAlgorithms: ['sha256'],
        // Written into app-update.yml: the updater installs only an update signed by this name.
        publisherName: [env('WIN_SIGN_PUBLISHER', from)]
      }
    }
  }
  if (plan.sign === 'developer-id') config.forceCodeSigning = true
  // No certificate: ad hoc, so the bundle's seal is whole; the hardened runtime would refuse Electron's
  // own frameworks under an ad hoc signature (no team to match).
  if (plan.sign === 'ad-hoc') config.mac = { ...config.mac, identity: '-', hardenedRuntime: false }
  if (plan.platform === 'darwin') config.mac = { ...config.mac, notarize: plan.notarize }
  return config
}

/** Windows PowerShell's environment: without PSModulePath, which PowerShell 7 (a pwsh CI step) sets to modules 5.1 can't load. */
const windowsPowerShellEnv = (extra = {}) => {
  const e = { ...process.env, ...extra }
  for (const k of Object.keys(e)) if (k.toLowerCase() === 'psmodulepath') delete e[k]
  return e
}

/** Runs a Windows PowerShell script with extra environment variables; its standard output. */
function powershell(script, extra = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: windowsPowerShellEnv(extra) })
  if (r.status !== 0) throw new Error(`PowerShell failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout
}

/** Runs a command; its standard output, or throws with what it printed. */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/** Fails unless ssign runs here (it is installed with cargo install ssign --locked, never downloaded as a binary). */
function checkSsign() {
  const r = spawnSync(env('SSIGN') || 'ssign', ['--version'], { encoding: 'utf8' })
  if (r.status !== 0) fail(`ssign does not run here (${(r.error?.message || r.stderr || r.stdout || '').trim()}).`, 'Install it with cargo install ssign --version <pinned> --locked, or point SSIGN at it.')
  console.log(`ssign: ${(r.stdout || '').trim()}`)
}

/** The DLLs Electron ships unsigned (ffmpeg.dll and the like), which Smart App Control checks too. */
function unsignedElectronDlls() {
  const dist = path.join(path.dirname(require.resolve('electron/package.json', { paths: [ROOT] })), 'dist')
  if (!existsSync(dist)) return []
  const out = powershell("Get-ChildItem -LiteralPath $env:ELECTRON_DIST -Filter *.dll | Get-AuthenticodeSignature | Where-Object { $_.Status -ne 'Valid' } | ForEach-Object { Split-Path $_.Path -Leaf }", { ELECTRON_DIST: dist })
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

/**
 * Builds main, preload and renderer into out/ as the open edition, main as bytecode (electron.vite.config.ts).
 * The switches of the other builds are blanked, whatever this shell has set: no hosted service, no beta, no
 * development switches, and no support address (so Report on an AI answer only copies, as the README says).
 * The bytecode is V8's, compiled by running Electron, and holds only on the CPU arch it was compiled on:
 * `electron` is the Electron executable to compile with (the packed arch's), else node_modules' own.
 */
function viteBuild(feed, electron = '', selfUpdate = false) {
  const pkg = require.resolve('electron-vite/package.json', { paths: [ROOT] })
  const bin = path.join(path.dirname(pkg), require(pkg).bin['electron-vite'])
  const edition = { FINANCE_TRACKER_EDITION: 'open', FINANCE_TRACKER_UPDATE_URL: feed, FINANCE_TRACKER_PROXY_URL: '', FINANCE_TRACKER_BETA_UNTIL: '', FINANCE_TRACKER_DATA_DIR_NAME: '', FINANCE_TRACKER_ALLOW_DEV: '', FINANCE_TRACKER_SUPPORT_EMAIL: '', FINANCE_TRACKER_MAC_SELF_UPDATE: selfUpdate ? '1' : '' }
  const r = spawnSync(process.execPath, [bin, 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, npm_lifecycle_event: 'dist:open', ELECTRON_EXEC_PATH: electron, ...edition } })
  if (r.status !== 0) throw new Error(`electron-vite build failed (${r.status})${electron ? ` with ${electron}` : ''}`)
}

/**
 * A whole Electron for `arch` on this Mac, to compile bytecode with: node_modules' own for this Mac's arch;
 * for the other, Electron's release zip for it (the same version, from @electron/get's cache), unzipped
 * with ditto into the temp folder. Not the one electron-builder unpacks into the app: that one has no
 * default_app.asar, so it can't run the compiler's script.
 */
async function electronFor(arch) {
  if (arch === process.arch) return ''
  if (arch === 'arm64') throw new Error('arm64 bytecode is compiled with arm64 Electron, which runs on Apple silicon only: build on an Apple silicon Mac')
  if (spawnSync('arch', ['-x86_64', '/usr/bin/true']).status !== 0) throw new Error('the x64 build compiles its bytecode with x64 Electron, which needs Rosetta: softwareupdate --install-rosetta --agree-to-license')
  const version = require(require.resolve('electron/package.json', { paths: [ROOT] })).version
  const dir = path.join(require('node:os').tmpdir(), `dist-open-electron-${version}-darwin-${arch}`)
  const exe = path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (!existsSync(exe)) {
    const { pathToFileURL } = require('node:url')
    const { downloadArtifact } = await import(pathToFileURL(require.resolve('@electron/get', { paths: [path.dirname(require.resolve('electron/package.json', { paths: [ROOT] }))] })).href)
    const zip = await downloadArtifact({ version, platform: 'darwin', arch, artifactName: 'electron' })
    require('node:fs').rmSync(dir, { recursive: true, force: true })
    const r = spawnSync('ditto', ['-x', '-k', zip, dir], { encoding: 'utf8' })
    if (r.status !== 0 || !existsSync(exe)) throw new Error(`could not unzip ${zip}: ${(r.stderr || r.stdout || '').trim()}`)
  }
  // Rosetta translates a binary the first time it runs, Electron's framework taking minutes, and
  // electron-vite gives its compiler 30 seconds to come up. One run as Node first leaves the
  // translation cached.
  const t0 = Date.now()
  const warm = spawnSync(exe, ['-e', 'process.exit(0)'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 600000 })
  if (warm.status !== 0) throw new Error(`x64 Electron did not run under Rosetta (${warm.error?.message ?? `exit ${warm.status}`}): ${(warm.stderr || warm.stdout || '').trim().slice(-1000)}`)
  console.log(`  x64 Electron ran under Rosetta in ${Math.round((Date.now() - t0) / 1000)} s (translated and cached)`)
  return exe
}

/**
 * macOS packs arm64 and x64 in one electron-builder run, so out/ is compiled again for each arch as it is
 * packed: after its Electron is unpacked (afterExtract) and before the app's files are copied in, with a
 * whole Electron of that arch (electronFor). On an Apple silicon Mac the x64 one runs under Rosetta.
 */
function compileForEachArch(feed, selfUpdate) {
  return async (context) => {
    const { Arch } = require('electron-builder')
    const arch = Arch[context.arch]
    const electron = await electronFor(arch)
    console.log(`\n  out/ for ${arch}, compiled with ${electron || "node_modules' Electron"}`)
    viteBuild(feed, electron, selfUpdate)
  }
}

/** The fuses scripts/fuses.cjs flips, as @electron/fuses reads them back. */
const FUSES = { RunAsNode: 'Disabled', EnableNodeOptionsEnvironmentVariable: 'Disabled', EnableNodeCliInspectArguments: 'Disabled', EnableEmbeddedAsarIntegrityValidation: 'Enabled', OnlyLoadAppFromAsar: 'Enabled', EnableCookieEncryption: 'Enabled' }

/** The packed apps in dist/: each one's executable and resources folder, with its arch. */
function packedApps(platform, productFilename) {
  if (platform === 'win32') return [{ arch: 'x64', binary: path.join(DIST, 'win-unpacked', `${productFilename}.exe`), resources: path.join(DIST, 'win-unpacked', 'resources') }]
  return [
    ['arm64', 'mac-arm64'],
    ['x64', 'mac']
  ]
    .map(([arch, dir]) => ({ arch, app: path.join(DIST, dir, `${productFilename}.app`) }))
    .filter((a) => existsSync(a.app))
    .map((a) => ({ ...a, binary: path.join(a.app, 'Contents', 'MacOS', productFilename), resources: path.join(a.app, 'Contents', 'Resources') }))
}

/** Fails unless every packed app has the fuses flipped and only its own arch's SQLite driver binary. */
async function checkApps(platform, apps) {
  const { getCurrentFuseWire, FuseV1Options, FuseState } = require('@electron/fuses')
  const bad = []
  const wantArches = platform === 'win32' ? ['x64'] : ['arm64', 'x64']
  const arches = apps.map((a) => a.arch)
  for (const want of wantArches) if (!arches.includes(want)) bad.push(`no ${want} app in dist`)
  for (const a of apps) {
    // On macOS the wire is in Electron Framework, which @electron/fuses finds from the app's executable.
    const wire = await getCurrentFuseWire(a.binary)
    const fuses = Object.entries(FUSES).map(([name, want]) => {
      const got = wire[FuseV1Options[name]] === FuseState.ENABLE ? 'Enabled' : wire[FuseV1Options[name]] === FuseState.DISABLE ? 'Disabled' : 'unknown'
      if (got !== want) bad.push(`${path.relative(DIST, a.binary)}: ${name} is ${got}, not ${want}`)
      return got === want
    })
    const prebuilds = path.join(a.resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3-multiple-ciphers', 'prebuilds')
    const nodes = existsSync(prebuilds) ? readdirSync(prebuilds) : []
    const want = `${platform}-${a.arch}.node`
    if (nodes.join() !== want) bad.push(`${path.relative(DIST, prebuilds)}: ${nodes.join(', ') || 'nothing'}, not ${want} alone`)
    console.log(`  ${a.arch}: ${fuses.filter(Boolean).length} of ${fuses.length} fuses as set; SQLite driver ${nodes.join(', ') || 'missing'}`)
  }
  if (bad.length) fail('The packed apps are not as built:', ...bad.map((b) => `  ${b}`))
}

/** latest.yml / latest-mac.yml's files: url, sha512 and size of each. */
function feedEntries(text) {
  const out = []
  for (const m of text.matchAll(/^ {2}- url: (.+)\n {4}sha512: (.+)\n {4}size: (\d+)/gm)) out.push({ url: m[1].trim().replace(/^'(.*)'$/, '$1'), sha512: m[2].trim(), size: Number(m[3]) })
  return out
}

/** Fails unless the feed file names files in dist/ whose size and SHA-512 it has right, with every installer or zip among them. */
function checkFeed(platform, version) {
  const name = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml'
  const file = path.join(DIST, name)
  if (!existsSync(file)) fail(`No dist/${name}: electron-builder wrote no update feed.`)
  const text = readFileSync(file, 'utf8')
  const bad = []
  if (!new RegExp(`^version: ${version.replace(/[.+]/g, '\\$&')}$`, 'm').test(text)) bad.push(`${name} is not for version ${version}`)
  const entries = feedEntries(text.replace(/\r\n/g, '\n'))
  for (const e of entries) {
    const p = path.join(DIST, e.url)
    if (/\s/.test(e.url)) bad.push(`${name} names ${e.url}, with a space`)
    if (!existsSync(p)) {
      bad.push(`${name} names ${e.url}, which is not in dist`)
      continue
    }
    const sha512 = createHash('sha512').update(readFileSync(p)).digest('base64')
    if (sha512 !== e.sha512 || statSync(p).size !== e.size) bad.push(`${name}: ${e.url} has another size or SHA-512`)
  }
  const want = platform === 'win32' ? [/\.exe$/] : [/-arm64\.zip$/, /-x64\.zip$/]
  for (const w of want) if (!entries.some((e) => w.test(e.url))) bad.push(`${name} names no file like ${w}`)
  if (bad.length) fail(`dist/${name} does not fit the build:`, ...bad.map((b) => `  ${b}`))
  console.log(`  ${name}: ${entries.map((e) => e.url).join(', ')}`)
  return name
}

/** Windows: every .exe and .node in the app, the DLLs signed and the installer, Valid, timestamped and issued to the publisher. */
function verifyWindows(installer, dlls) {
  const files = []
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const full = path.join(dir, n)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(exe|node)$/i.test(n) || dlls.includes(n)) files.push(full)
    }
  }
  walk(path.join(DIST, 'win-unpacked'))
  files.push(installer)
  // The signer's name as the certificate's simple name (its CN, unquoted: "Lobos Labs, Inc." has a comma).
  const out = powershell("$env:SIGNED_FILES -split \"`n\" | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; $n = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }; '{0}|{1}|{2}|{3}' -f $s.Status, $n, [bool]$s.TimeStamperCertificate, $_ }", { SIGNED_FILES: files.join('\n') })
  const publisher = env('WIN_SIGN_PUBLISHER')
  const bad = out.trim().split(/\r?\n/).filter((l) => {
    const [status, name, stamped] = l.split('|')
    return !(status === 'Valid' && name === publisher && stamped === 'True')
  })
  if (bad.length) fail(`Not signed as expected (Valid, by ${publisher}, timestamped):`, ...bad.map((b) => `  ${b}`))
  console.log(`  signed: ${files.length} files, Valid, by ${publisher}, timestamped`)
}

/** macOS: each app's signature holds (codesign --verify --deep --strict); the authority it names. */
function verifyMac(apps, plan) {
  const authorities = []
  for (const a of apps) {
    run('codesign', ['--verify', '--deep', '--strict', a.app])
    const info = run('codesign', ['-dv', '--verbose=2', a.app])
    const authority = /^Authority=(.+)$/m.exec(info)?.[1] ?? (/^Signature=adhoc$/m.test(info) ? 'ad hoc' : 'unknown')
    if (plan.sign === 'developer-id' && !authority.startsWith('Developer ID Application:')) fail(`${a.app} is signed by ${authority}, not a Developer ID Application certificate`)
    if (plan.notarize) run('xcrun', ['stapler', 'validate', a.app])
    console.log(`  ${a.arch}: signature valid, ${authority}${plan.notarize ? ', notarized and stapled' : ''}`)
    authorities.push(authority)
  }
  return [...new Set(authorities)]
}

async function main() {
  const platform = process.platform
  const plan = signingPlan(platform)
  const feed = env('FINANCE_TRACKER_UPDATE_URL')
  if (!feed) plan.problems.push('FINANCE_TRACKER_UPDATE_URL is not set: a release names its feed, https://github.com/<owner>/<repo>/releases/latest/download')
  if (plan.problems.length) fail('dist:open cannot build as set:', ...plan.problems.map((p) => `  ${p}`))
  console.log(`dist:open: ${platform}, signing ${plan.sign}${plan.platform === 'darwin' ? `, ${plan.notarize ? '' : 'not '}notarized` : ''}; feed ${feed}`)
  if (process.argv.includes('--check')) return
  if (plan.sign === 'ssign') checkSsign()
  const windowsSigned = plan.sign === 'ssign' || plan.sign === 'signtool'
  const dlls = windowsSigned ? unsignedElectronDlls() : []

  const { build, Platform, Arch } = require('electron-builder')
  const config = builderConfig(plan, feed, { dlls })
  // Windows builds x64 on x64: out/ once, with node_modules' Electron.
  if (platform === 'win32') viteBuild(feed)
  else config.afterExtract = compileForEachArch(feed, macSelfUpdate(plan))
  const targets = platform === 'win32' ? Platform.WINDOWS.createTarget(['nsis'], Arch.x64) : Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64, Arch.x64)
  const artifacts = await build({ projectDir: ROOT, targets, config, publish: 'never' })

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const productFilename = (pkg.productName ?? pkg.name).replace(/[/\\:*?"<>|]/g, '')
  console.log('\nThe build:')
  const apps = packedApps(platform, productFilename)
  await checkApps(platform, apps)
  const feedFile = checkFeed(platform, pkg.version)
  const installer = artifacts.find((a) => a.toLowerCase().endsWith('.exe'))
  let signer = null
  if (windowsSigned) {
    verifyWindows(installer, dlls)
    signer = env('WIN_SIGN_PUBLISHER')
  }
  if (platform === 'darwin') signer = verifyMac(apps, plan).join(', ')

  const assets = readdirSync(DIST)
    .filter((n) => statSync(path.join(DIST, n)).isFile() && (/\.(exe|dmg|zip|blockmap)$/.test(n) || n === feedFile))
    .sort()
  const record = { version: pkg.version, platform, signing: plan.sign, signer, notarized: plan.notarize, feed, assets }
  writeFileSync(path.join(DIST, `release-${platform}.json`), JSON.stringify(record, null, 2) + '\n')
  console.log(`\ndist/release-${platform}.json: ${assets.join(', ')}`)
}

if (require.main === module) main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)))

module.exports = { signingPlan, builderConfig, feedEntries, macSelfUpdate, FUSES }
