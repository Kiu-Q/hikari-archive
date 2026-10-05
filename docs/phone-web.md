# Use Hikari from your phone

The phone browser connects to a small Hikari server on this computer. The server serves the web app and keeps the OpenClaw credential on the computer; it forwards chat requests to local OpenClaw and starts local TTS on demand. Keep this computer awake and online while using Hikari from the phone.

## First setup

Install and sign in to Tailscale on both this computer and your phone, using the same tailnet. Tailscale Serve gives the local Hikari server a private HTTPS address for devices on that tailnet. Do not expose the OpenClaw or TTS ports directly.

On the computer, start Tailscale Serve for Hikari's local port:

```sh
tailscale serve --bg 3000
tailscale serve status
```

Copy the HTTPS address shown by `tailscale serve status`, then start Hikari with that address as the allowed browser origin. The server reads `HIKARI_OPENCLAW_TOKEN` when set, or the gateway token from `~/.openclaw/openclaw.json` otherwise:

```sh
# Only needed if the token is not already in ~/.openclaw/openclaw.json:
# export HIKARI_OPENCLAW_TOKEN='your-local-openclaw-token'
export HIKARI_PUBLIC_ORIGIN='https://your-computer.your-tailnet.ts.net'
npm run start:web
```

`npm run start:web` builds the web app into `dist-web` and starts the Hikari server on `127.0.0.1:3000`. Keep this terminal running. OpenClaw must be running on this computer at `127.0.0.1:18789`. The Hikari server starts its TTS service lazily when the first speech request arrives. The OpenClaw token belongs in the server process environment or its local OpenClaw config only; do not put it in a `VITE_` variable or `.env.web`, because Vite variables can be included in browser code. `HIKARI_PUBLIC_ORIGIN` accepts comma-separated exact origins if you need to allow more than one.

If the `tailscale` command in Terminal is connected to a different or unavailable daemon on macOS, use the CLI bundled with the Tailscale app after opening and signing in to that app:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

On the phone, open the HTTPS address from `tailscale serve status`. You can add the page to the home screen for app-like access. The phone view uses the animated `loading.gif` as a full-screen backdrop behind Hikari's transparent canvas. Its full-width bottom row keeps history, the glass chat field, and the green glass Send button together on a transparent container. The composer stays visible while you open settings or conversation history; the history control only opens and closes history. The default web camera is closer, and the successful connection notice fades after four seconds (connection problems stay visible). Browser mode disables sit and walk animations, including agent animation requests, and starts with only the turn-around animation before idling. The startup greeting is enabled on the web as well as Electron. Both versions begin generating Japanese audio as soon as a spoken reply arrives, while presentation waits for startup or earlier animations to finish. Drag one finger to move Hikari's gaze or touch the model; use two fingers to zoom and pan. The first milestone supports typed chat and Japanese voice replies; phone microphone input is not included yet. Touch the model or Send once to unlock audio; replies then play automatically. The player attempts automatic audio recovery before each reply and when returning to the page. Ordinary taps also unlock audio; the on-screen audio prompt remains only as a fallback when the browser requires a fresh gesture.

## Keep the host available

The computer must stay awake, connected to the internet and connected to Tailscale. On macOS, you can prevent idle sleep while the server runs with:

```sh
caffeinate -i npm run start:web
```

The phone cannot reach OpenClaw or local TTS while this server or OpenClaw is stopped.

## Development and build commands

- `npm run build:web` creates a local-root web build in `dist-web`. It deliberately ignores the GitHub Pages prefix in `.env.web`.
- `npm run build:web:github` uses `.env.web` for a GitHub Pages build. The configured asset prefix is adjusted to match the shared `electron/assets` directory. GitHub Pages serves static files only; chat and TTS need a same-origin Hikari API server.
- `npm run start:web` builds the phone app and serves it with the local API.
- `npm run serve:web` starts the Hikari server without rebuilding `dist-web`.
- `npm run dev:web` starts Vite on port `8081`; keep the Hikari server running on port `3000` so Vite can proxy `/api` requests to it.
- `npm run preview:web:static` previews an already-built web UI only. Use the Hikari server for chat and TTS API requests.

For development, start the backend first in one terminal, then start Vite in a second terminal. The web build reads its VRM, animation, and loading assets directly from `electron/assets`, so desktop and phone use the same source files. Vite sets `--hikari-background-image` from the web asset base; mobile panel positions use `--keyboard-inset` and `--visible-height` so settings and history stay above the composer and within the visible screen when the software keyboard is open, in portrait or landscape.

## Use the local service with Electron

To share TTS with Electron, start the Hikari server first, then run Electron with:

```sh
HIKARI_SERVICE_URL=http://127.0.0.1:3000 npm run dev:electron
```

This routes Electron speech through the same server-owned TTS queue. Electron chat keeps its existing gateway settings; browser chat uses the server-held credential. Close any older standalone Electron session before first starting shared mode, so the server owns TTS startup. Closing Electron in shared mode does not stop the phone service. Without `HIKARI_SERVICE_URL`, Electron retains its standalone TTS behavior.

## References

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
