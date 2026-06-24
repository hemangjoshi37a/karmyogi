# Wi-Fi relay — reach a FluidNC/ESP3D board from the HTTPS site

## Why you need this

Browsers **forbid an insecure `ws://` connection from a page served over
`https://`** (mixed active content). Networked GRBL boards
(FluidNC / ESP3D / MKS DLC32) expose only **plain `ws://`** (no TLS), so the
deployed site at **`https://karmyogi.hjlabs.in`** cannot reach them directly —
`wss://` fails (the board has no TLS) and `ws://` is blocked by the browser.

You have three ways to use Wi-Fi:

1. **Run karmyogi over `http://` on your LAN** (simplest) — `ws://` is allowed
   from an `http://` page. `HTTPS= npm run dev -- --host 0.0.0.0` then open
   `http://<your-LAN-ip>:5185`. (Loses camera + Web Serial, which need a secure
   context — but Wi-Fi GRBL works.)
2. **Use this relay** — keep using the HTTPS site; the relay presents a `wss://`
   endpoint on your LAN and forwards to the board's `ws://`.
3. **Use USB** instead of Wi-Fi.

## Using the relay

From the repo root (after `npm install`):

```bash
npm run wifi-relay -- --target 192.168.29.128:80
# or: node scripts/wifi-relay.mjs --target ws://192.168.29.128:80 --port 8443
```

- `--target <host[:port]>` — your board's WebSocket (the IP + port that works
  over plain `ws://`; default port 80). **Required.**
- `--port <n>` — local `wss://` listen port (default `8443`).
- `--host <addr>` — bind address (default `0.0.0.0`, all interfaces).
- `--cert <file> --key <file>` — use your own TLS cert/key instead of the
  auto-generated self-signed one.

The relay prints the URLs to use. Then:

1. **Accept the certificate once.** Open the printed `https://<ip>:8443/` in the
   same browser and click through the self-signed-cert warning (the relay uses a
   self-signed cert unless you pass `--cert/--key`).
2. In karmyogi → **Connect ▸ Wi-Fi (WebSocket)**, paste the printed
   **`wss://<ip>:8443`** into the Host field and connect.

Run the relay on a machine that can reach **both** your browser and the board.
It must stay running while you're connected. `Ctrl-C` to stop.

## Notes

- This is a thin byte-for-byte bridge: it terminates TLS and pipes frames in
  both directions, so GRBL streaming/realtime bytes pass through unchanged.
- It's a dev/LAN helper (Node script using `ws` + `selfsigned`, both
  devDependencies) — it is **not** part of the static SPA bundle.
- For a permanent setup, put a real reverse proxy (nginx/Caddy with a trusted
  cert) in front of the board instead of the self-signed relay.
