// DEV-ONLY Vite plugin (plain JS — intentionally outside the app tsconfig so it
// can use Node APIs without pulling @types/node into the browser build).
//
// Receives a camera frame POSTed from the browser and saves it to disk on the
// server at ./.camera-frames/<name>.png, so a developer/agent running on the
// server can SEE what a networked client's camera sees (closed-loop tuning of
// the camera calibration). POST a PNG data-URL (or raw base64) body to
// `/__camera_frame?name=<label>`. Serve-time only (apply: 'serve').
import { writeFileSync, mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'

export function cameraFrameReceiver() {
  return {
    name: 'karmyogi-camera-frame-receiver',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__camera_frame', (req, res, next) => {
        if (req.method !== 'POST') return next()
        // Collect RAW bytes (the client posts a binary image/png blob — far more
        // reliable than a base64 text body, which was getting truncated in
        // transit). A base64 data-URL body is still accepted as a fallback.
        const chunks = []
        let total = 0
        req.on('data', (chunk) => {
          chunks.push(chunk)
          total += chunk.length
          if (total > 32 * 1024 * 1024) req.destroy() // ~32MB guard
        })
        req.on('end', () => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const name = (url.searchParams.get('name') || 'frame')
              .replace(/[^a-zA-Z0-9._-]/g, '_')
              .slice(0, 60)
            const buf = Buffer.concat(chunks)
            const ct = String(req.headers['content-type'] || '')
            let out
            if (ct.startsWith('image/')) {
              out = buf // raw binary PNG/JPEG
            } else {
              const body = buf.toString('utf8').trim()
              const m = /^data:image\/\w+;base64,(.+)$/s.exec(body)
              out = Buffer.from(m ? m[1] : body, 'base64')
            }
            if (!out || out.length < 64) {
              res.statusCode = 422
              res.end('empty frame')
              return
            }
            const isJpeg = ct.includes('jpeg') || (out[0] === 0xff && out[1] === 0xd8)
            const ext = isJpeg ? 'jpg' : 'png'
            mkdirSync('.camera-frames', { recursive: true })
            writeFileSync(`.camera-frames/${name}.${ext}`, out)
            // Diagnostic: declared vs received vs decoded, + whether the image is
            // complete (PNG ends with IEND; JPEG ends with FFD9). Localises any truncation.
            const cl = req.headers['content-length']
            const complete = isJpeg
              ? out.length >= 2 && out[out.length - 2] === 0xff && out[out.length - 1] === 0xd9
              : out.length >= 8 &&
                out[out.length - 8] === 0x49 && out[out.length - 7] === 0x45 &&
                out[out.length - 6] === 0x4e && out[out.length - 5] === 0x44
            // eslint-disable-next-line no-console
            console.log(
              `[camera-frame] ${name}.${ext} ct=${ct || '?'} content-length=${cl || '?'} bodyBytes=${total} decoded=${out.length} complete=${complete ? 'YES' : 'NO(truncated)'}`,
            )
            res.statusCode = 200
            res.setHeader('content-type', 'text/plain')
            res.end(`saved .camera-frames/${name}.png`)
          } catch {
            res.statusCode = 500
            res.end('error saving frame')
          }
        })
      })
    },
  }
}
