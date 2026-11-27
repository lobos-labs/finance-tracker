// electron-builder's Windows sign hook (win.signtoolOptions.sign), which npm run dist:open
// (scripts/dist-open.cjs) sets only when Windows signing is configured. electron-builder calls it once
// for each file, SHA-256 only, after afterPack has flipped the fuses (scripts/fuses.cjs): the app's
// executable, the SQLite driver's .node and the DLLs Electron ships unsigned, then elevate.exe, the
// uninstaller and the installer. One of two signers, by what the environment holds:
//   ssign     A Certum SimplySign cloud certificate: CERTUM_EMAIL and CERTUM_OTP (the TOTP seed or its
//             otpauth:// URI), or CERTUM_TOKEN (a current six-digit code) instead of the seed. ssign
//             (crates.io, MIT) signs any PE file by its headers, so the .node too, timestamps it from
//             time.certum.pl, and refuses a file that already carries a signature.
//   signtool  A certificate in a .pfx file: WIN_SIGN_PFX and WIN_SIGN_PFX_PASSWORD, timestamped from
//             WIN_SIGN_TIMESTAMP_URL (time.certum.pl by default). open-release-test.yml signs this way
//             with a throwaway certificate, to test this hook end to end.
// A file that already has a valid signature (none of the above should) is left as it is.
const { spawnSync } = require('node:child_process')
const { closeSync, existsSync, openSync, readdirSync, readSync, statSync } = require('node:fs')
const path = require('node:path')

const env = (name) => (process.env[name] ?? '').trim()

/** Which signer the environment configures: 'ssign', 'signtool' or null. */
const signer = () => (env('CERTUM_EMAIL') ? 'ssign' : env('WIN_SIGN_PFX') ? 'signtool' : null)

/** The size of a PE file's certificate table (its Authenticode signature); 0 when it has none. */
function certificateTableSize(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4096)
    readSync(fd, head, 0, head.length, 0)
    if (head.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file} is not a PE file`)
    const pe = head.readUInt32LE(0x3c)
    if (pe + 24 + 240 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${file} has no PE header`)
    const optional = pe + 24
    const magic = head.readUInt16LE(optional)
    const dirs = optional + (magic === 0x20b ? 112 : 96)
    // Data directory 4 is the certificate table: its offset, then its size.
    return head.readUInt32LE(dirs + 4 * 8 + 4)
  } finally {
    closeSync(fd)
  }
}

/** Get-AuthenticodeSignature's status for the file. */
function signatureStatus(file) {
  // Without PSModulePath: PowerShell 7 (a pwsh CI step) sets it to modules Windows PowerShell can't load.
  const e = { ...process.env, SIGN_FILE: file }
  for (const k of Object.keys(e)) if (k.toLowerCase() === 'psmodulepath') delete e[k]
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AuthenticodeSignature -LiteralPath $env:SIGN_FILE).Status.ToString()'], { encoding: 'utf8', env: e })
  return String(r.stdout ?? '').trim()
}

/** signtool.exe from the newest Windows SDK on this machine (GitHub's Windows runners have one). */
function signtool() {
  if (env('WIN_SIGNTOOL')) return env('WIN_SIGNTOOL')
  const kits = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = existsSync(kits) ? readdirSync(kits).filter((v) => /^10\./.test(v)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).reverse() : []
  for (const v of versions) {
    const exe = path.join(kits, v, 'x64', 'signtool.exe')
    if (existsSync(exe)) return exe
  }
  throw new Error('no signtool.exe: install the Windows SDK, or point WIN_SIGNTOOL at one')
}

/** The command that signs `file` in place, for the configured signer. `name` is the description signtool and ssign put in the signature. */
function command(kind, file, name) {
  if (kind === 'ssign') {
    // ssign reads CERTUM_EMAIL, CERTUM_OTP and CERTUM_TOKEN itself, so no secret is on the command line.
    return { cmd: env('SSIGN') || 'ssign', args: ['-n', name, file] }
  }
  return {
    cmd: signtool(),
    args: ['sign', '/fd', 'sha256', '/f', env('WIN_SIGN_PFX'), ...(env('WIN_SIGN_PFX_PASSWORD') ? ['/p', env('WIN_SIGN_PFX_PASSWORD')] : []), '/tr', env('WIN_SIGN_TIMESTAMP_URL') || 'http://time.certum.pl', '/td', 'sha256', '/d', name, file]
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The hook: signs `configuration.path` in place, retrying a failure twice (the signing service and the timestamp server are remote). */
module.exports = async function sign(configuration) {
  const file = configuration.path
  const kind = signer()
  if (!kind) throw new Error('sign-win.cjs: no signer configured (CERTUM_EMAIL or WIN_SIGN_PFX), yet electron-builder asked to sign')
  const short = path.basename(file)
  if (certificateTableSize(file) > 0) {
    const status = signatureStatus(file)
    if (status === 'Valid') {
      console.log(`  sign-win: ${short} already has a valid signature; left as it is`)
      return
    }
    throw new Error(`${file} already carries a signature (${status || 'unreadable'}) that is not valid, and it can't be signed over`)
  }
  const { cmd, args } = command(kind, file, configuration.name || path.basename(file, path.extname(file)))
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now()
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
    // Never echo signtool's arguments (the .pfx password); its output names the file.
    last = `${r.error ? r.error.message : ''}${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    if (r.status === 0 && certificateTableSize(file) > 0) {
      console.log(`  sign-win: ${short} signed with ${kind} (${statSync(file).size} bytes, ${Date.now() - t0} ms)`)
      return
    }
    // A run that failed after writing a signature can't be retried: ssign refuses a signed file.
    if (certificateTableSize(file) > 0) break
    if (attempt < 3) await sleep(10000 * attempt)
  }
  throw new Error(`${kind} could not sign ${file}: ${last.slice(-1500)}`)
}

module.exports.signer = signer
module.exports.certificateTableSize = certificateTableSize
module.exports.command = command
