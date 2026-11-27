import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Account, DemoStatus, ImportPreview, OnboardingState } from '../../shared/types'
import { useApp } from './App'
import { Icon } from './Icon'
import { api, errorMessage, onWeb } from './lib'
import { ImportModal } from './pages/StatementImportModal'
import { DOCUMENT_ACCEPT, DOCUMENT_FILE, IMPORT_FILE, pickFiles } from './web/files'

// Empty states and the sample set: one short label at most, then the buttons
// that fill the page. Shared by the pages, Home and Settings → Data.

/** A page with nothing on it: an optional label and its action buttons. */
export function EmptyCard({ label, children, style }: { label?: string; children: ReactNode; style?: CSSProperties }): ReactNode {
  return (
    <div className="card empty" style={style}>
      {label && <div className="muted">{label}</div>}
      <div className="empty-actions">{children}</div>
    </div>
  )
}

/** Picks a CSV (or QFX, OFX, QIF) and runs the import dialog, wherever the button sits. */
export function ImportCsvButton({ className = 'btn', children }: { className?: string; children?: ReactNode }): ReactNode {
  const { toast } = useApp()
  const [csv, setCsv] = useState<ImportPreview | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])

  async function pick(): Promise<void> {
    try {
      const p = await api.csvPick()
      if (!p) return
      setAccounts((await api.listAccounts()).filter((a) => a.source !== 'manual'))
      setCsv(p)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <>
      <button className={className} onClick={() => void pick()}>
        <Icon name="upload" size={15} /> {children ?? 'Import file'}
      </button>
      {csv && <ImportModal preview={csv} accounts={accounts} onClose={() => setCsv(null)} />}
    </>
  )
}

/**
 * The web's way in for documents (no folder to open): files, or a whole folder, uploaded for the AI to
 * read; a CSV, QFX, OFX or QIF among them opens the import dialog.
 */
export function UploadButton({ folder = false, className = 'btn primary', children }: { folder?: boolean; className?: string; children: ReactNode }): ReactNode {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const [csv, setCsv] = useState<ImportPreview | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])

  async function upload(): Promise<void> {
    const picked = await pickFiles({ multiple: true, folder, accept: DOCUMENT_ACCEPT })
    // A folder brings everything in it; only what the server keeps goes up.
    const files = folder ? picked.filter((f) => DOCUMENT_FILE.test(f.name) || IMPORT_FILE.test(f.name)) : picked
    if (!files.length) return
    setBusy(true)
    try {
      const r = await api.importDocuments(files.map((f) => api.pathForFile(f)))
      if (r.saved.length) toast(`Uploaded ${r.saved.length}`)
      if (r.rejected.length) toast(`Not a document: ${r.rejected.length === 1 ? r.rejected[0] : `${r.rejected.length} files`}`, 'error')
      if (r.csv) {
        setAccounts((await api.listAccounts()).filter((a) => a.source !== 'manual'))
        setCsv(r.csv)
      }
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className={className} disabled={busy} onClick={() => void upload()}>
        <Icon name={folder ? 'folder' : 'upload'} size={15} /> {busy ? 'Uploading…' : children}
      </button>
      {csv && <ImportModal preview={csv} accounts={accounts} onClose={() => setCsv(null)} />}
    </>
  )
}

/** Opens the documents folder, or one of its subfolders; what lands there, the AI files in Review. On the web, an upload. */
export function OpenFolderButton({ sub, className = 'btn primary', children }: { sub?: string; className?: string; children: ReactNode }): ReactNode {
  const { toast } = useApp()
  if (onWeb()) return <UploadButton className={className}>{children}</UploadButton>
  return (
    <button className={className} onClick={() => api.openDocumentFolder(sub).catch((e) => toast(errorMessage(e), 'error'))}>
      <Icon name="folder" size={15} /> {children}
    </button>
  )
}

export function LoadSampleButton({ className = 'btn ghost', onLoaded }: { className?: string; onLoaded?: () => void }): ReactNode {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)

  async function load(): Promise<void> {
    setBusy(true)
    try {
      const r = await api.loadDemoData()
      toast(`Sample data · ${r.accounts} accounts · ${r.transactions.toLocaleString()} transactions`)
      onLoaded?.()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button className={className} disabled={busy} onClick={() => void load()}>
      {busy ? 'Loading…' : 'Load sample data'}
    </button>
  )
}

export function RemoveSampleButton({ className = 'btn ghost', children }: { className?: string; children?: ReactNode }): ReactNode {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await api.clearDemoData()
      toast('Sample data removed')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button className={className} disabled={busy} onClick={() => void remove()}>
      {busy ? 'Removing…' : (children ?? 'Remove')}
    </button>
  )
}

/** Whether the sample set is loaded, refreshed with the rest of the data. */
export function useDemoStatus(): DemoStatus | null {
  const { tick } = useApp()
  const [status, setStatus] = useState<DemoStatus | null>(null)
  useEffect(() => {
    api.demoStatus().then(setStatus, () => {})
  }, [tick])
  return status
}

/** One line over Home while the sample set is loaded. */
export function SampleDataBar(): ReactNode {
  const status = useDemoStatus()
  if (!status?.loaded) return null
  return (
    <div className="banner sample-bar">
      <Icon name="layers" />
      <div>
        <strong>Sample data</strong>
      </div>
      <div className="spacer" />
      <RemoveSampleButton />
    </div>
  )
}

/** Settings → Data: the documents folder and the sample set. */
export function DataFolders(): ReactNode {
  const { tick, toast } = useApp()
  const [state, setState] = useState<OnboardingState | null>(null)
  useEffect(() => {
    api.getOnboarding().then(setState, () => {})
  }, [tick])
  if (!state) return null

  const sample = (
    <div className="sample-settings">
      <div className="label-muted" style={{ marginTop: 18, marginBottom: 6 }}>
        Sample data
      </div>
      <div className="row">{state.demo.loaded ? <RemoveSampleButton className="btn danger">Remove sample data</RemoveSampleButton> : <LoadSampleButton className="btn" />}</div>
    </div>
  )
  // The web has no folders: documents come in by upload.
  if (onWeb())
    return (
      <>
        <div className="label-muted" style={{ marginTop: 18, marginBottom: 6 }}>
          Documents
        </div>
        <div className="row">
          <UploadButton className="btn">Upload files</UploadButton>
          <UploadButton className="btn" folder>
            Upload folder
          </UploadButton>
        </div>
        {sample}
      </>
    )

  const fail = (e: unknown): void => toast(errorMessage(e), 'error')
  const change = (): void => {
    api.setDocumentsDir(null).then((dir) => dir && setState((s) => s && { ...s, docsDir: dir }), fail)
  }
  const setExtra = (dirs: string[] | null): void => {
    if (dirs) setState((s) => s && { ...s, extraDirs: dirs })
  }

  return (
    <>
      <div className="label-muted" style={{ marginTop: 18, marginBottom: 6 }}>
        Documents
      </div>
      <div className="row">
        <code className="data-path truncate">{state.docsDir}</code>
        <button className="btn" onClick={() => api.openDocumentFolder().catch(fail)}>
          <Icon name="folder" size={15} /> Open folder
        </button>
        {!state.docsDirLocked && (
          <button className="btn" onClick={change}>
            Change…
          </button>
        )}
      </div>
      <div className="label-muted" style={{ marginTop: 18, marginBottom: 6 }}>
        Extra document folders
      </div>
      {state.extraDirs.map((d) => (
        <div className="row extra-dir" key={d} style={{ marginBottom: 6 }}>
          <code className="data-path truncate">{d}</code>
          <button className="btn small ghost icon-btn danger" aria-label={`Remove ${d}`} onClick={() => api.removeDocumentFolder(d).then(setExtra, fail)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => api.addDocumentFolder(null).then(setExtra, fail)}>
          <Icon name="plus" size={14} /> Add folder
        </button>
      </div>
      {sample}
    </>
  )
}
