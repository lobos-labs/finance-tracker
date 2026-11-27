import { useEffect, useState, type ReactNode } from 'react'
import type { Account, ImportPreview } from '../../shared/types'
import { useApp } from './App'
import { api, errorMessage } from './lib'
import { ImportModal } from './pages/StatementImportModal'

// Files dropped anywhere on the window go to the documents folder's Other
// subfolder (the AI files them in Review); a CSV, QFX, OFX or QIF opens the import dialog
// instead. A page's own drop target (a health cost's receipt) keeps priority:
// once it has taken the event, nothing happens here.

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

export function DropZone(): ReactNode {
  const { toast } = useApp()
  const [over, setOver] = useState(false)
  const [csv, setCsv] = useState<ImportPreview | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])

  useEffect(() => {
    // dragover fires continuously while files are over the window; the veil
    // hides a moment after it stops.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (e.defaultPrevented) return setOver(false)
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setOver(true)
      clearTimeout(timer)
      timer = setTimeout(() => setOver(false), 200)
    }
    const onDrop = (e: DragEvent): void => {
      clearTimeout(timer)
      setOver(false)
      if (!hasFiles(e) || e.defaultPrevented) return
      e.preventDefault()
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => api.pathForFile(f))
        .filter(Boolean)
      if (!paths.length) return
      api.importDocuments(paths).then(
        async (r) => {
          if (r.saved.length) toast(`Saved ${r.saved.length} to Other`)
          for (const name of r.skipped) toast(`Already there: ${name}`)
          for (const name of r.rejected) toast(`Not a document: ${name}`, 'error')
          if (r.csv) {
            setAccounts((await api.listAccounts()).filter((a) => a.source !== 'manual'))
            setCsv(r.csv)
          }
        },
        (err) => toast(errorMessage(err), 'error')
      )
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [toast])

  return (
    <>
      {over && (
        <div className="drop-veil" aria-hidden>
          <span>Drop to save</span>
        </div>
      )}
      {csv && <ImportModal preview={csv} accounts={accounts} onClose={() => setCsv(null)} />}
    </>
  )
}
