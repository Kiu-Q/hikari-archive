# Use Hikari from your phone

The phone browser connects to a small Hikari server on this computer. The server serves the web app and keeps the OpenClaw credential on the computer; it forwards chat requests to local OpenClaw and starts local TTS on demand. Keep this computer awake and online while using Hikari from the phone.

## First setup

Install and sign in to Tailscale on both this computer and your phone, using the same tailnet. Tailscale Serve gives the local Hikari server a private HTTPS address for devices on that tailnet. Do not expose the OpenClaw or TTS ports directly.

On the computer, start Tailscale Serve for Hikari's local port:

```sh
tailscale serve --bg 3000
tailscale serve status
```

This computer's configured HTTPS address is `https://node.tailb3abce.ts.net`. The start command sets it as the allowed browser origin automatically; set `HIKARI_PUBLIC_ORIGIN` to override it on another host. The server reads `HIKARI_OPENCLAW_TOKEN` when set, or the gateway token from `~/.openclaw/openclaw.json` otherwise:

```sh
# Only needed if the token is not already in ~/.openclaw/openclaw.json:
# export HIKARI_OPENCLAW_TOKEN='your-local-openclaw-token'
npm run start:web
```

`npm run start:web` builds the web app into `dist-web` and starts the Hikari server on `127.0.0.1:3000`. Keep this terminal running. OpenClaw must be running on this computer at `127.0.0.1:18789`. The Hikari server starts its TTS service lazily when the first speech request arrives. The OpenClaw token belongs in the server process environment or its local OpenClaw config only; do not put it in a `VITE_` variable or `.env.web`, because Vite variables can be included in browser code. `HIKARI_PUBLIC_ORIGIN` accepts comma-separated exact origins if you need to allow more than one.

If the `tailscale` command in Terminal is connected to a different or unavailable daemon on macOS, use the CLI bundled with the Tailscale app after opening and signing in to that app:

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

On the phone, open the HTTPS address from `tailscale serve status`. You can add the page to the home screen for app-like access. The phone view uses the animated `loading.gif` as a full-screen backdrop behind Hikari's transparent canvas. Its full-width bottom row keeps history, the glass chat field, and the green glass Send button together on a transparent container. The composer stays visible while you open settings or conversation history; the history control only opens and closes history. The default web camera is closer, and the successful connection notice fades after four seconds (connection problems stay visible). Browser mode disables sit and walk animations, including agent animation requests, and starts with only the turn-around animation before idling. The startup greeting is enabled on the web as well as Electron. Both versions begin generating Japanese audio as soon as a spoken reply arrives, while presentation waits for startup or earlier animations to finish. Drag one finger to move Hikari's gaze or touch the model; use two fingers to zoom and pan. The first milestone supports typed chat and Japanese voice replies; phone microphone input is not included yet. Touch the model or Send once to unlock audio; replies then play automatically. The player attempts automatic audio recovery before each reply and when returning to the page. Audio gesture handling starts before the avatar renderer, and every reply reuses that same context. There is no separate voice-play button: ordinary taps, keyboard input, and Send unlock pending audio. A fresh browser page may still require one ordinary interaction before unmuted audio can play. If audio is blocked, the reply caption is displayed while waiting for that interaction.

## Browser features shared with Electron

The loading GIF covers the app throughout avatar loading and startup, with only the loading status label visible above it. Once chat is ready, the loading label disappears and the GIF overlay fades out smoothly over one second to reveal the app. Send becomes available when the overlay clears. Drafts typed during startup are retained. Your first Send takes priority over an unfinished greeting, including a greeting waiting for audio permission or TTS. Sending status appears beside the draft, and startup failures offer Reload. The server compresses avatar, animation, and app downloads losslessly for faster phone loading.

The web entry point imports the Electron renderer directly, so phone and desktop share the response protocol, bilingual captions, Japanese voice sequencing, facial expressions, local attention, and enabled animation settings. The browser settings use the same tab navigation and close/Escape behavior: General includes speaking speed, eye-follow angle, a touch/pointer gaze switch, and Reset view; Motion includes the browser-safe animation and expression controls; Lighting adjusts all five lights. Speed, gaze, motion, and lighting preferences persist in this browser. Reset view restores the phone camera after zooming or panning.

Use the 📷 button beside Send to choose a photo or screenshot from the phone's image picker. The selection is resized and converted to JPEG locally, shown as a removable draft, and sent only when you press Send. An image can be sent without typed text. Failed sends retain the draft for retry; successful sends clear it. Each request accepts one JPEG up to 2 MB; source files must be under 20 MB. Image understanding requires a vision-capable model configured in OpenClaw. Later conversation turns retain a text note and history thumbnail rather than retransmitting the image. Settings and history sit above the enlarged composer when the keyboard is closed. Opening the software keyboard lifts only the composer; the avatar, backdrop, and other controls stay in place.

Desktop window controls, desktop awareness, native screen capture, and Apple on-device voice listening remain Electron features. The browser uses user-selected images and typed chat, without requesting desktop or microphone permissions. Sitting and walking remain disabled on the phone.

## Keep the host available

The computer must stay awake, connected to the internet and connected to Tailscale. `start:web` automatically prevents idle sleep on macOS for as long as the server runs. Use the npm script Run button or this single command:

```sh
npm run start:web
```

The phone cannot reach OpenClaw or local TTS while this server or OpenClaw is stopped.

## Development and build commands

- `npm run build:web` creates a local-root web build in `dist-web`. It deliberately ignores the GitHub Pages prefix in `.env.web`.
- `npm run build:web:github` uses `.env.web` for a GitHub Pages build. The configured asset prefix is adjusted to match the shared `electron/assets` directory. GitHub Pages serves static files only; chat and TTS need a same-origin Hikari API server.
- `npm run start:web` builds the phone app, allows the configured Tailscale HTTPS origin, and serves it with the local API. On macOS it also runs the server under `caffeinate -i`. Running it again restarts an existing Hikari server from this project on port `3000`; other applications are left running. Stop it with Ctrl+C.
- `npm run serve:web` starts the Hikari server without rebuilding `dist-web`.
- `npm run dev:web` starts Vite on port `8081`; keep the Hikari server running on port `3000` so Vite can proxy `/api` requests to it.

For development, start the backend first in one terminal, then start Vite in a second terminal. The web build reads its VRM, animation, and loading assets directly from `electron/assets`, so desktop and phone use the same source files. Vite sets `--hikari-background-image` from the web asset base; the phone keeps a stable scene height and compensates for visual viewport panning while `--keyboard-inset` lifts only the composer above the software keyboard.

Run the regression suite with `node --test test/*.test.js`. After a web build, run `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/web-browser.smoke.mjs` for an isolated Chromium browser-mode check on test port `3099`. It uses test-only chat and audio to exercise the real avatar renderer, startup drafts, settings, image preparation/send/history, and portrait/landscape layout without using your browser profile or OpenClaw account. `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/web-startup.smoke.mjs` checks first Send with a stalled greeting and no preliminary tap, on test port `3098`.

## Use the local service with Electron

To share TTS with Electron, start the Hikari server first, then run Electron with:

```sh
HIKARI_SERVICE_URL=http://127.0.0.1:3000 npm run dev
```

This routes Electron speech through the same server-owned TTS queue. Electron chat keeps its existing gateway settings; browser chat uses the server-held credential. Close any older standalone Electron session before first starting shared mode, so the server owns TTS startup. Closing Electron in shared mode does not stop the phone service. Without `HIKARI_SERVICE_URL`, Electron retains its standalone TTS behavior.

## References

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
