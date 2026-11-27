// Uploading files to the hosted service is not in this edition. Empty.tsx's
// upload button is shown only on the web (onWeb()); the desktop opens its
// documents folder instead. The patterns stay for the button's filter, and the
// picker picks nothing.

export const IMPORT_FILE = /\.(csv|qfx|ofx|qif)$/i
export const DOCUMENT_FILE = /\.(pdf|png|jpe?g|heic|heif)$/i
export const DOCUMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.heic,.heif,application/pdf,image/png,image/jpeg,image/heic'

export function pickFiles(_o: { accept?: string; multiple?: boolean; folder?: boolean } = {}): Promise<File[]> {
  return Promise.resolve([])
}
