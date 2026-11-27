import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

// The Claude Desktop extension: an .mcpb, a zip with manifest.json at its
// root beside the relay (resources/claude-extension/server/index.cjs), which
// Claude Desktop runs on its own built-in Node. The relay carries this build's
// name, home folder, version and instructions, so the extension is made when
// the user asks for it (Settings → Claude Desktop → Install in Claude Desktop)
// rather than when the app is built, with a small zip writer of our own. Its
// manifest is version 0.3 (github.com/modelcontextprotocol/mcpb, MANIFEST.md,
// read 2026-11-05), the current one, which every Claude Desktop that takes
// extensions reads. Claude Desktop names an installed extension
// local.mcpb.<author>.<name>, so both stay fixed: a newer file replaces the
// one installed instead of adding a second. The name follows the home folder
// (".finance-tracker" is "finance-tracker"), not the product, so a rename of
// the product keeps the extension's place.

export const MANIFEST_VERSION = '0.3'
/** The extension's author: part of its identity in Claude Desktop, so it never changes. */
export const EXTENSION_AUTHOR = 'Lobos Labs'
/** The relay, inside the extension. */
export const EXTENSION_ENTRY = 'server/index.cjs'
/** The unpacked copy's folder, beside the .mcpb (Claude Desktop's Install Unpacked Extension takes a folder). */
export const UNPACKED_DIR = 'claude-extension'

/** Where the relay's source holds the values filled in here. */
const BUILT = /\/\* built \*\/[^\n]*?\/\* end \*\//

/** What goes in the extension. */
export interface ExtensionOptions {
  appName: string
  version: string
  /** the hidden folder in the home directory where the app writes the connection file (build.ts HOME_DIR_NAME) */
  homeDirName: string
  /** what Claude Desktop is told when it starts the relay (connector.ts CONNECTOR_INSTRUCTIONS) */
  instructions: string
  /** the relay's source, resources/claude-extension/server/index.cjs */
  template: string
  /** the app's icon, a PNG; without one the manifest names none */
  icon?: Buffer | null
  /** the tools the relay lists while the app isn't answering (mcp.ts mcpTools(false), the reads), so Claude Desktop always has some and each call says to open the app */
  tools?: unknown[]
}

/** A file in the archive: its path inside it (forward slashes) and its bytes. */
export interface ZipEntry {
  name: string
  data: Buffer
}

/** The extension's name in Claude Desktop: the home folder's, without its dot. */
export const extensionName = (homeDirName: string): string => homeDirName.replace(/^\.+/, '') || 'finance-tracker'

/** The manifest (MANIFEST.md 0.3: manifest_version, name, version, description, author.name and server are required). */
export function extensionManifest(o: Pick<ExtensionOptions, 'appName' | 'version' | 'homeDirName'> & { icon: boolean }): Record<string, unknown> {
  return {
    manifest_version: MANIFEST_VERSION,
    name: extensionName(o.homeDirName),
    display_name: o.appName,
    version: o.version,
    description: `Your ${o.appName} books in Claude Desktop, through the running ${o.appName} app.`,
    author: { name: EXTENSION_AUTHOR },
    ...(o.icon ? { icon: 'icon.png' } : {}),
    server: {
      type: 'node',
      entry_point: EXTENSION_ENTRY,
      // Claude Desktop fills in ${__dirname}, the installed extension's folder.
      mcp_config: { command: 'node', args: ['${__dirname}/' + EXTENSION_ENTRY] }
    },
    // The tools come from the running app.
    tools_generated: true,
    // Claude Desktop's built-in Node (24 today) meets this, so it never looks for one on the system.
    compatibility: { platforms: ['win32', 'darwin'], runtimes: { node: '>=18.0.0' } }
  }
}

/** The relay with this build's values in place of the template's. */
export function shimSource(template: string, built: { app: string; homeDir: string; version: string; instructions: string; tools: unknown[] }): string {
  if (!BUILT.test(template)) throw new Error('The relay has no place for its built values')
  // A function, so a "$" in the values is never read as a replacement pattern.
  return template.replace(BUILT, () => `/* built */ ${JSON.stringify(built)} /* end */`)
}

/** The extension's files: the manifest, the relay and the icon. */
export function extensionFiles(o: ExtensionOptions): ZipEntry[] {
  const icon = o.icon && o.icon.length ? o.icon : null
  const manifest = extensionManifest({ appName: o.appName, version: o.version, homeDirName: o.homeDirName, icon: !!icon })
  return [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: EXTENSION_ENTRY, data: Buffer.from(shimSource(o.template, { app: o.appName, homeDir: o.homeDirName, version: o.version, instructions: o.instructions, tools: o.tools ?? [] }), 'utf8') },
    ...(icon ? [{ name: 'icon.png', data: icon }] : [])
  ]
}

/** The time and date fields of a zip header (MS-DOS format, local time, two-second steps). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/**
 * A zip of the entries: each deflated (method 8), or stored (0) when deflating
 * doesn't make it smaller, with UTF-8 names and ordinary file modes. No Zip64:
 * an extension is far under 4 GB. Claude Desktop reads methods 0 and 8.
 */
export function zip(entries: ZipEntry[], at: Date = new Date()): Buffer {
  const { time, date } = dosTime(at)
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8')
    const deflated = deflateRawSync(e.data, { level: 9 })
    const method = deflated.length < e.data.length ? 8 : 0
    const body = method === 8 ? deflated : e.data
    const crc = crc32(e.data)

    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4) // version needed: 2.0
    head.writeUInt16LE(0x0800, 6) // the name is UTF-8
    head.writeUInt16LE(method, 8)
    head.writeUInt16LE(time, 10)
    head.writeUInt16LE(date, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(e.data.length, 22)
    head.writeUInt16LE(name.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, name, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, 2.0, so the mode below is read
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(e.data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    // No extra field, comment, disk number or internal attributes.
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38) // a regular file, rw-r--r--
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)

    offset += head.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

/** A file name from the product's name: nothing Windows or macOS refuses in one. */
const fileName = (appName: string): string => appName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || 'extension'

/**
 * Writes the extension into `dir` (the hidden folder in the home directory,
 * which Claude Desktop reads from inside its package on Windows): the .mcpb,
 * and the same files unpacked beside it, for Claude Desktop's Install Unpacked
 * Extension when installing the file doesn't work.
 */
export function writeExtension(dir: string, o: ExtensionOptions): { file: string; folder: string } {
  const files = extensionFiles(o)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${fileName(o.appName)}.mcpb`)
  writeFileSync(file, zip(files))
  const folder = join(dir, UNPACKED_DIR)
  for (const f of files) {
    const to = join(folder, ...f.name.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, f.data)
  }
  return { file, folder }
}
