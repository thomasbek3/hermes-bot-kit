// A PNG data URL that is only a signature and an IHDR header saying
// width × height: enough for the avatar checks (format, face-raster size).
export function pngDataUrl(width, height) {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return `data:image/png;base64,${head.toString('base64')}`
}
