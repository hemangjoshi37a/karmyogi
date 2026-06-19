// Serve the ZXing reader wasm at a STABLE absolute URL (/zxing_reader.wasm) in
// BOTH dev and production builds, so the QR decoder's locateFile() can always
// find it. The `?url` import of a dependency's .wasm is flaky under Vite dev
// (the decoder then silently falls back to the weaker jsQR), so this guarantees
// the robust ZXing decoder actually loads everywhere.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

export function zxingWasm() {
  const require = createRequire(import.meta.url)
  let wasmPath = null
  try {
    wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm')
  } catch {
    /* not installed — decoder will error gracefully */
  }
  return {
    name: 'karmyogi-zxing-wasm',
    configureServer(server) {
      server.middlewares.use('/zxing_reader.wasm', (_req, res, next) => {
        if (!wasmPath) return next()
        try {
          res.setHeader('Content-Type', 'application/wasm')
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          res.end(readFileSync(wasmPath))
        } catch {
          next()
        }
      })
    },
    generateBundle() {
      if (!wasmPath) return
      this.emitFile({ type: 'asset', fileName: 'zxing_reader.wasm', source: readFileSync(wasmPath) })
    },
  }
}
