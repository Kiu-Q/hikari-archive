<picture>
  <source
    width="100%"
    srcset="banner.png"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="banner.png"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="250" src="banner.png" />
</picture>

<h1 align="center">Hikari Archive</h1>

<p align="center">Inspired by <a href="https://github.com/moeru-ai/airi">Project AIRI</a>, bringing VRM characters to life with interactive AI companions powered by <a href="https://github.com/openclaw/openclaw">OpenClaw</a> agent integration.</p>

<p align="center">
  [<a href="https://github.com/Kiu-Q/hikari-archive">View on GitHub</a>] [<a href="https://github.com/Kiu-Q/hikari-archive/issues">Report Issues</a>]
</p>

<p align="center">
  <a href="https://github.com/Kiu-Q/hikari-archive/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Kiu-Q/hikari.svg?style=flat&colorA=080f12&colorB=1fa669"></a>
  <a href="https://github.com/Kiu-Q/hikari-archive"><img src="https://img.shields.io/github/stars/Kiu-Q/hikari.svg?style=flat&colorA=080f12&colorB=1fa669"></a>
</p>

<p align="center">
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white&labelColor=47848F" alt="Electron"></a>
  <a href="https://vitejs.dev/"><img src="https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white&labelColor=646CFF" alt="Vite"></a>
  <a href="https://threejs.org/"><img src="https://img.shields.io/badge/Three.js-000000?logo=threedotjs&logoColor=white&labelColor=000000" alt="Three.js"></a>
  <a href="https://pixiv.github.io/three-vrm/"><img src="https://img.shields.io/badge/VRM-FF61B6?logo=pixiv&logoColor=white&labelColor=FF61B6" alt="VRM"></a>
</p>

> Heavily inspired by [Project-AIRI](https://www.youtube.com/@Neurosama)

> [!NOTE]
>
> Hikari Archive is designed to work with the OpenClaw Agent Gateway for AI agent communication.
>
> Make sure you have OpenClaw installed and running before using Hikari Archive.

> [!TIP]
> Hikari Archive supports both Electron desktop and Web/Mobile versions with a shared codebase.
>
> Use the Electron version for desktop applications with window management, or the Web version for remote access via Tailscale.

> [!WARNING]
> **This project is heavily vibe-coded**
>
> What does "vibe-coded" mean? It means the code was written based on intuition, vibes, and "it just works" mentality rather than following strict software engineering best practices, comprehensive testing, or thorough documentation.
>
> **Consequences you might encounter:**
> - **Inconsistent code style**: Different parts may have different coding patterns
> - **Limited documentation**: Some features may lack detailed explanations
> - **Mysterious bugs**: Things that break for unclear reasons
> - **"Spaghetti code"**: Complex interdependencies that are hard to untangle
> - **Feature creep**: Features added because they seemed cool at the time
> - **Testing gaps**: Edge cases that weren't properly tested
>
> **But it works!** The core functionality is solid, and the project is usable. Contributions to improve code quality, add tests, and improve documentation are highly welcome!

Have you dreamed about having a 3D virtual character that can interact with you in real-time, displaying emotions, lip-syncing to speech, and playing animations?

Hikari Archive brings virtual characters to life with:
- **VRM 3D Models**: Display and control VRM (Virtual Reality Model) characters
- **Real-time Animations**: 14 pre-built animations including idle states, gestures, and movements
- **Lip Sync**: Synchronize mouth movements with speech (English and Chinese support)
- **Facial Expressions**: Apply expressions like happy, sad, angry, surprised, and more
- **Automatic Systems**: Natural blinking, eye saccade, and random idle animations
- **Touch Interaction**: Click/touch on model to trigger agent responses
- **AI Integration**: WebSocket communication with OpenClaw agent gateway for AI interactions
- **Cross-Platform**: Runs on Electron desktop and Web browsers with mobile support

## What's So Special About This Project?

Unlike other VRM viewers, Hikari Archive was built with a focus on real-time AI agent integration and cross-platform compatibility from the ground up.

> [!TIP]
> Worried about performance or compatibility?
>
> Hikari Archive uses modern Web technologies (Three.js, WebGL) optimized for both desktop and mobile devices. The Electron version provides native window management, while the Web version offers remote access capabilities through Tailscale.

Hikari Archive is capable of running on:
- **Desktop**: Native Electron application with window dragging, local file access, and system integration
- **Web/Mobile**: Browser-based version with touch controls, responsive design, and remote access via Tailscale
- **Shared Codebase**: Core logic (VRM rendering, animations, WebSocket) is shared between both versions

> [!NOTE]
>
> We are actively developing Hikari Archive and welcome contributions from the community.
>
> **Interested in contributing? [Open an issue](https://github.com/Kiu-Q/hikari-archive/issues) or [start a discussion](https://github.com/Kiu-Q/hikari-archive/discussions)!**

## Current Progress

Capable of

- [x] Character System
  - [x] VRM model loading and rendering
  - [x] VRM model optimization (Spring Bone physics)
  - [x] VRMA animation support (14 animations)
  - [x] Facial expressions (neutral, happy, sad, angry, surprised, blink)
  - [x] Automatic blinking system
  - [x] Eye saccade (natural eye movement)
  - [ ] Intro message when page loaded
  - [ ] Pose fully controlled by agent
- [x] Animation System
  - [x] Smooth transitions with cross-fade
  - [x] Automatic startup sequence
  - [x] Random idle animations
  - [x] Walk sequences (Electron + Web versions)
  - [ ] Touch and drag animation
  - [ ] More animations
- [x] Communication
  - [x] Lip sync system (English + Chinese)
  - [x] Speaking bubble UI
  - [x] WebSocket integration with OpenClaw
  - [x] Conversation history panel
  - [ ] Stream messages to OpenClaw channels (Telegram, WhatsApp, etc.)
  - [ ] Enhanced lip sync
  - [ ] Video call mode
- [x] Controls & Interface
  - [x] Orbit controls (rotate, zoom, pan)
  - [x] 3-point lighting system
  - [x] Toggle panels (settings, messages, history)
  - [x] Window dragging (Electron)
  - [x] Touch controls (Web/Mobile)
  - [ ] Interact with your screen
- [x] Cross-Platform
  - [x] Electron desktop application
  - [x] Web browser version
  - [x] Mobile support with Tailscale remote access
  - [x] Shared codebase

## Development

> [!NOTE]
> By default, `npm run dev` will start the development server for the Electron version. If you would like to try the Web version, use `npm run dev:web`.

```shell
npm i
npm run dev
```

### Web/Mobile Version

```shell
npm run dev:web
```

### Building for Production

```shell
# Build Electron app
npm run build:electron

# Build Web app
npm run build:web

# Create distributables
npm run make
```

## Prerequisites

### Required Software
- **Node.js** (v16 or higher) - https://nodejs.org/
- **npm** or **pnpm** - Package manager
- **Git** - For cloning (optional)
- **OpenClaw Agent Gateway** - https://github.com/openclaw/openclaw
- **Tailscale** (for remote mobile access) - https://tailscale.com/

### System Requirements
- **OS**: Windows 10+, macOS 10.15+, or Linux
- **RAM**: 4GB minimum, 8GB recommended
- **GPU**: WebGL 2.0 compatible
- **Network**: Local network for development, internet for Tailscale remote access

## Installation

### Step 1: Clone Repository

```bash
git clone https://github.com/Kiu-Q/hikari-archive.git
cd hikari
```

### Step 2: Install Dependencies

```bash
npm install
```

This will install:
- Electron (desktop framework)
- Vite (build tool)
- Three.js (3D graphics)
- @pixiv/three-vrm (VRM loader)
- @pixiv/three-vrm-animation (VRMA animation support)
- ws (WebSocket client)

### Step 3: Configure OpenClaw

Edit OpenClaw configuration file at `~/.openclaw/config.json`:

```json
{
  "gateway": {
    "bind": "0.0.0.0:18789",
    "token": "YOUR_GATEWAY_TOKEN_HERE"
  }
}
```

**Important:**
- `"bind": "0.0.0.0:18789"` allows external connections
- `"token"` is required for authentication
- Keep your token secure - don't share it!

### Step 4: Start OpenClaw Gateway

```bash
openclaw gateway start
```

## Quick Start

### Option A: Electron Desktop Version (Recommended)

**1. Start Electron Version** (This automatically starts both asset server and Electron app)

```bash
npm run dev:electron
```

**2. Configure OpenClaw Token**

- Click ⚙️ (top-left) to open settings panel
- Enter your OpenClaw gateway token
- Click "Save Token"

### Option B: Web/Mobile Version

**1. Get Your Tailscale IP**

```bash
tailscale ip -4
```

**2. Start Web Version** (This automatically starts both asset server and web dev server)

```bash
npm run dev:web
```

**3. Access from Phone or Browser**

Open browser and navigate to:
```
http://YOUR_TAILSCALE_IP:3000/renderer/index-web.html
```

## Usage

### Basic Controls

#### Desktop (Electron)
- **Rotate Camera**: Right-click and drag
- **Zoom Camera**: Scroll wheel
- **Pan Camera**: Middle-click and drag (or Ctrl + right-click)
- **Reset Camera**: Click "Reset Camera" button
- **Drag Window**: Drag from any visible area
- **Toggle Settings**: Hover over ⚙️ (top-left)
- **Toggle Messages**: Hover over 💬 (bottom-left)
- **Toggle History**: Hover over 📜 (bottom-right)

#### Mobile (Web)
- **Rotate Camera**: Touch and drag
- **Zoom Camera**: Pinch gesture
- **Reset Camera**: Click "Reset Camera" button
- **Toggle Settings**: Tap ⚙️ (top-left)
- **Toggle Messages**: Tap 💬 (bottom-left)
- **Toggle History**: Tap 📜 (bottom-right)

### Animation Controls

#### Manual Animation Selection
1. Click 💬 to open messaging panel
2. Open animation dropdown
3. Select desired animation
4. Animation plays once (except idle_loop)
5. Returns to idle_loop when complete

#### Automatic Animations
- **Startup**: Plays stand up → turn around → idle_loop
- **Random Idle**: Every 20-30 seconds, plays random animation
- **Suspended**: During speaking or user-selected animations

### Lip Sync

#### Speaking Text
1. Click 💬 to open messaging panel
2. Type text in input field
3. Click "Speak" or press Enter
4. Text sent to OpenClaw agent
5. Agent processes and responds
6. Hikari Archive lip syncs response

#### Supported Languages
- **English**: Word-by-word lip sync
- **Chinese**: Character-by-character lip sync

### Facial Expressions

#### Manual Expression Selection
1. Click 💬 to open messaging panel
2. Open expression dropdown
3. Select expression (neutral, happy, sad, angry, surprised, blink)
4. Expression applied immediately

#### Expression Timing
- Manual expressions persist until changed
- Lip sync expressions override manual during speech
- Returns to manual expression after speech

### Touch Interaction

The VRM character responds to clicks/touches on different body parts:

#### How It Works
- **Click or touch** on the model to trigger interaction
- The system identifies which body part was touched (head, chest, hip, leg)
- Sends touch message to OpenClaw agent
- Agent responds with animation, expression, and speech
- Character plays sit animation during agent processing

#### Touch Debouncing
- 1-second cooldown between touches to prevent spam
- Touch messages include body part context for agent response

#### Supported Body Parts
- **Head** - Touching the character's head area
- **Chest** - Touching the upper body
- **Hip** - Touching the lower body
- **Leg** - Touching the character's legs

### Conversation History

#### Viewing History
1. Click 📜 (bottom-right) to open history panel
2. Last 50 messages displayed (newest first)
3. Shows sender, timestamp, and message text

#### Loading More Messages
1. Click "Load More Messages" button at bottom
2. Fetches additional 50 messages from OpenClaw
3. Messages appended to existing list

## Available Animations

### Idle Animations
| File | Description | Loop |
|------|-------------|------|
| `idle_loop.vrma` | Continuous idle animation | Yes |
| `idle_airplane.vrma` | Make airplane gesture with arm | No |
| `idle_shoot.vrma` | Make shooting gesture with hand | No |
| `idle_sport.vrma` | Do sports movements/stretching | No |
| `idle_stretch.vrma` | Stretch body and limbs | No |
| `idle_vSign.vrma` | Make V-sign with hand | No |

### Startup Animations
| File | Description | Loop |
|------|-------------|------|
| `start_1standUp.vrma` | Stand up from sitting position | No |
| `start_2turnAround.vrma` | Turn around to face camera | No |

### Interaction Animations
| File | Description | Loop |
|------|-------------|------|
| `wave_both.vrma` | Wave with both hands | No |
| `wave_left.vrma` | Wave with left hand | No |
| `wave_right.vrma` | Wave with right hand | No |
| `sit.vrma` | Sit down on ground | No |
| `sitWave.vrma` | Sit and wave to greet | No |

### Movement Animations
| File | Description | Loop |
|------|-------------|------|
| `walk.vrma` | Walk sequence (Electron: horizontal, Web: forward/back) | No |

## Available Expressions

| Name | Description | Duration |
|------|-------------|----------|
| `neutral` | Default expression | Persistent |
| `happy` | Happy face | Persistent |
| `sad` | Sad face | Persistent |
| `angry` | Angry face | Persistent |
| `surprised` | Surprised face | Persistent |
| `blink` | Single blink | 200ms (auto-reset) |

## WebSocket Protocol

### Client → OpenClaw Requests

#### Send Message to Agent
```json
{
  "type": "req",
  "id": "msg-1772803015796-g5j3by",
  "method": "agent",
  "params": {
    "message": "Hello, Hikari Archive!",
    "sessionKey": "main",
    "timeout": 10,
    "idempotencyKey": "msg-1772803015796-g5j3by"
  }
}
```

#### Fetch Conversation History
```json
{
  "type": "req",
  "id": "history-1772803015796",
  "method": "chat.history",
  "params": {
    "sessionKey": "main",
    "limit": 50,
    "includeSystem": false,
    "order": "desc"
  }
}
```

### OpenClaw → Client Responses

#### Chat Message (Final - Complete)
```json
{
  "type": "event",
  "event": "chat",
  "payload": {
    "runId": "msg-1772803015796-g5j3by",
    "sessionKey": "main",
    "seq": 18,
    "state": "final",
    "message": {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "This message is complete"
        }
      ],
      "timestamp": 1772803019253
    }
  },
  "seq": 22034
}
```

#### Conversation History Response
```json
{
  "type": "history",
  "payload": {
    "messages": [
      {
        "from": "user",
        "text": "Hello!",
        "timestamp": "2026-03-07T03:00:00.000Z"
      },
      {
        "from": "agent",
        "text": "{\"text\":\"Hi!\"}",
        "timestamp": "2026-03-07T03:01:00.000Z"
      }
    ],
    "totalCount": 150,
    "hasMore": true
  }
}
```

## Project Structure

```
hikari/
├── electron/              # Electron-specific files
│   ├── main.js          # Main process (window creation, IPC)
│   └── preload.js       # Bridge between main and renderer
├── src/                 # Core application logic
│   ├── core.js          # Three.js, VRM, animations, lip sync (SHARED)
│   ├── websocket.js     # WebSocket client (SHARED)
│   ├── main.js          # Electron entry point
│   ├── web.js           # Web entry point
│   └── conversation-history.js  # Conversation history UI
├── renderer/            # UI and assets
│   ├── index.html       # Electron HTML
│   ├── index-web.html   # Web HTML
│   └── assets/
│       ├── VRM/         # VRM model files
│       │   └── sample.vrm
│       └── VRMA/        # VRMA animation files
│           ├── idle_loop.vrma
│           ├── walk.vrma
│           └── ...
├── package.json         # Dependencies and scripts
├── vite.config.js      # Vite configuration
└── forge.config.cjs    # Electron Forge configuration
```

## Troubleshooting

### Issue: WebSocket Connection Failed

**Symptoms:**
- `[ws] WebSocket error: Connection refused`
- `[ws] WebSocket closed`
- Token error in console

**Solutions:**

1. **Check OpenClaw is running:**
   ```bash
   openclaw status
   openclaw gateway status
   ```

2. **Verify gateway port:** Should be 18789

3. **Check firewall:** Allow port 18789 through firewall

4. **Verify token:** Check token in settings panel

### Issue: VRM Model Not Loading

**Symptoms:**
- "Error loading VRM model"
- Character not visible

**Solutions:**

1. **Check asset server:**
   ```bash
   npm run start:asset-server
   ```

2. **Verify file paths:** Check `renderer/assets/VRM/` directory

3. **Check browser console:** Look for CORS errors

### Issue: Animations Not Playing

**Solutions:**

1. **Check VRMA files:** Verify files in `renderer/assets/VRMA/`

2. **Check asset server:** Test accessing VRMA files in browser

3. **Verify VRM compatibility:** Ensure VRM model supports animations

### Issue: Lip Sync Not Working

**Solutions:**

1. **Check VRM morph targets:** Ensure VRM has mouth morph targets

2. **Test with simple text:** Try "Hello world" or "你好"

3. **Verify agent response:** Check OpenClaw agent is responding

### Issue: Remote Access Not Working

**Solutions:**

1. **Verify Tailscale:**
   ```bash
   tailscale status
   tailscale ip -4
   ```

2. **Check Funnel mode:**
   ```bash
   tailscale funnel list
   ```

3. **Enable Funnel (if not enabled):**
   ```bash
   tailscale funnel 18789
   ```

## Advanced Configuration

### Custom WebSocket URL

**Electron Mode:**
- Edit settings panel in app
- Or modify `src/main.js` default URL

**Web Mode:**
- Edit settings panel in app
- Or modify `src/web.js` default URL

### Custom Asset Server Port

Change asset server port in `asset-server.js`:

```javascript
const PORT = 8080; // Change from 3000
```

### Custom Animations

Add your own VRMA animations:

1. **Place VRMA files:**
   ```bash
   cp your-animation.vrma renderer/assets/VRMA/
   ```

2. **Update animation list:**
   - Edit `src/core.js`
   - Add to `VRMA_ANIMATION_URLS` array
   - Restart app

### Customization

#### Custom VRM Model

Replace the default VRM model:

1. **Place VRM file:**
   ```bash
   cp your-model.vrm renderer/assets/VRM/sample.vrm
   ```

2. **Verify compatibility:**
   - VRM 1.0 format
   - Required bone structure
   - Morph targets for expressions

#### Custom Loading Screen

Replace the default loading animation:

1. **Place your loading GIF:**
   ```bash
   cp your-loading.gif renderer/assets/loading.gif
   ```

2. **Recommended specifications:**
   - GIF format
   - 512x512 to 1080x1080 resolution
   - Loop seamlessly
   - File size under 1MB for fast loading

### Transparent Window (VTuber Overlay)

For VTuber use cases, enable transparent window:

**1. Edit Electron config (`electron/main.js`):**
```javascript
const win = new BrowserWindow({
  transparent: true,
  frame: false,
  alwaysOnTop: true,
});
```

**2. Update renderer (`src/core.js`):**
```javascript
const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setClearColor(0x000000, 0); // Transparent background
```

## Security Best Practices

### Token Management

1. **Never commit tokens to git**
2. **Use environment variables for production**
3. **Rotate tokens regularly**

### Network Security

1. **Enable 2FA on Tailscale account**
2. **Review connected devices regularly**
3. **Use strong gateway tokens**

### Code Security

1. **Sanitize WebSocket messages**
2. **Validate animation file names**
3. **Escape user input in UI**

## Support and Resources

### Documentation
- **OpenClaw**: https://github.com/openclaw/openclaw
- **Three.js**: https://threejs.org/docs/
- **@pixiv/three-vrm**: https://github.com/pixiv/three-vrm
- **Electron**: https://www.electronjs.org/docs/
- **Vite**: https://vitejs.dev/guide/

## Acknowledgements

- **Three.js** - 3D graphics library
- **@pixiv/three-vrm** - VRM model loader and utilities
- **@pixiv/three-vrm-animation** - VRMA animation support
- **Electron** - Cross-platform desktop framework
- **Vite** - Fast build tool with HMR
- **OpenClaw** - AI agent gateway
- **pixiv/ChatVRM** - Inspiration for VRM integration
- **josephrocca/ChatVRM-js** - JS conversion/adaptation of ChatVRM

## License

MIT License - See LICENSE file for details

---

**Enjoy using Hikari Archive! 🎭**