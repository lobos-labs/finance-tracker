import { win32 } from 'node:path'

// A Microsoft Store (MSIX) install sees %APPDATA% and %LOCALAPPDATA% as usual,
// but what it creates there lands in its package's own folder,
// %LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming (or \Local).
// Explorer runs outside the package and sees only the real folders, so the
// app opens the package's folder itself. The family name is <Name>_<PublisherId>,
// read from the install folder under WindowsApps:
// <Name>_<Version>_<Architecture>_<ResourceId>_<PublisherId>. Uninstalling
// deletes the package's folder with everything in it, so a Store build keeps
// its backups in the documents folder instead. Windows paths only (a Store
// build runs on Windows); no Electron here, so the tests read it plain.

/** The package family name from the running executable's path under WindowsApps; null when it isn't one. */
export function packageFamilyName(execPath: string): string | null {
  const parts = execPath.split(/[\\/]+/)
  const at = parts.findIndex((p) => p.toLowerCase() === 'windowsapps')
  const full = at >= 0 ? parts[at + 1] : undefined
  if (!full) return null
  // The resource id is usually empty: Name_1.2.3.0_x64__8wekyb3d8bbwe.
  const fields = full.split('_')
  if (fields.length !== 5) return null
  const [name, version, arch, , publisherId] = fields
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(name) || !/^\d+\.\d+\.\d+\.\d+$/.test(version) || !/^(x86|x64|arm|arm64|neutral)$/i.test(arch) || !/^[a-z0-9]{13}$/i.test(publisherId)) return null
  return `${name}_${publisherId}`
}

export interface StoreFolders {
  /** %APPDATA% as the app sees it */
  appData: string
  /** %LOCALAPPDATA% */
  localAppData: string
  /** the package family name; null when it can't be told */
  family: string | null
}

/** `child` inside `parent` (or the same folder), compared as Windows does, without case: the part below it, else null. */
function below(parent: string, child: string): string | null {
  const rel = win32.relative(parent, child)
  if (rel === '') return ''
  if (rel.startsWith('..') || win32.isAbsolute(rel)) return null
  return rel
}

/**
 * Where a folder the app sees at `path` under AppData really is: the package's
 * LocalCache\Roaming or LocalCache\Local (a path in the package's folder already
 * is itself). Null when it isn't under AppData or the family isn't known.
 */
export function redirectedPath(path: string, f: StoreFolders): string | null {
  if (!f.family) return null
  const pkg = win32.join(f.localAppData, 'Packages', f.family)
  if (below(pkg, path) !== null) return win32.normalize(path)
  const cache = win32.join(pkg, 'LocalCache')
  const roaming = below(f.appData, path)
  if (roaming !== null) return win32.join(cache, 'Roaming', roaming)
  const local = below(f.localAppData, path)
  if (local !== null) return win32.join(cache, 'Local', local)
  return null
}

/** Whether a path is under AppData, where a Store build's writes are redirected. */
export const underAppData = (path: string, f: Pick<StoreFolders, 'appData' | 'localAppData'>): boolean => below(f.appData, path) !== null || below(f.localAppData, path) !== null

/**
 * How a Store build opens one of its folders: `open` a folder Explorer can see
 * (one outside AppData, or the package's real one when it's there); else
 * `show` the path as the app sees it, selected in its parent.
 */
export function storeFolderTarget(path: string, f: StoreFolders, exists: (p: string) => boolean): { open: string } | { show: string } {
  if (!underAppData(path, f)) return { open: path }
  const real = redirectedPath(path, f)
  if (real && exists(real)) return { open: real }
  return { show: path }
}

/** A Store build's backups: in the documents folder, which an uninstall leaves. */
export const storeBackupsDir = (docsDir: string): string => win32.join(docsDir, 'Backups')
