import { ipcMain as r, app as s, session as f, BrowserWindow as l } from "electron";
import i from "path";
import { fileURLToPath as c } from "url";
import { existsSync as m } from "fs";
const p = c(import.meta.url), a = i.dirname(p), d = process.env.NODE_ENV === "development" || !m(i.join(a, "../dist/index.html"));
let e = null;
function u() {
  e = new l({
    width: 600,
    height: 900,
    transparent: !0,
    frame: !1,
    alwaysOnTop: !0,
    resizable: !0,
    webPreferences: {
      preload: i.join(a, "preload.js"),
      contextIsolation: !0,
      nodeIntegration: !1,
      webSecurity: !d,
      backgroundThrottling: !1
    }
  }), d ? (e.loadURL("http://localhost:5174/electron/index.html"), e.webContents.openDevTools()) : e.loadFile(i.join(a, "../dist/index.html"));
}
r.handle("get-window-position", () => {
  if (!e) return { x: 0, y: 0 };
  const t = e.getPosition();
  return { x: t[0], y: t[1] };
});
r.handle("set-window-position", (t, o, n) => e ? (e.setPosition(Math.round(o), Math.round(n)), !0) : !1);
r.handle("get-window-bounds", () => e ? e.getBounds() : { width: 0, height: 0, x: 0, y: 0 });
r.handle("set-window-bounds", (t, o, n, h, w) => e ? (e.setBounds({
  x: Math.round(o),
  y: Math.round(n),
  width: Math.max(200, Math.round(h)),
  height: Math.max(300, Math.round(w))
}), !0) : !1);
r.handle("set-ignore-mouse-events", (t, o, n) => e ? (e.setIgnoreMouseEvents(o, { forward: n !== !1 }), !0) : !1);
s.whenReady().then(() => {
  f.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["ws://*/*", "wss://*/*"] },
    (t, o) => {
      if (t.requestHeaders)
        try {
          const n = new URL(t.url);
          t.requestHeaders.Origin = `${n.protocol}//${n.host}`;
        } catch {
        }
      o({ requestHeaders: t.requestHeaders });
    }
  ), u(), s.on("activate", () => {
    l.getAllWindows().length === 0 && u();
  });
});
s.on("window-all-closed", () => {
  process.platform !== "darwin" && s.quit();
});
