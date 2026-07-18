const MAX_PAPER_ID_LENGTH = 160

export function isSafePaperpipeId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PAPER_ID_LENGTH
    && !value.includes('..')
    && !/[\\/\u0000\r\n]/.test(value)
}

export function sanitizePaperFilename(value) {
  const name = typeof value === 'string' ? value.split(/[\\/]/).pop() : ''
  return (name || 'paper.pdf').replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 180)
}

export function hasPdfMagicBytes(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

export function extractRemotePaperId(data) {
  const candidate = data?.paper?.id ?? data?.paperId ?? data?.id
  return isSafePaperpipeId(candidate) ? candidate : undefined
}
