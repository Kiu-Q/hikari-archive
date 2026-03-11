import { ipcMain as r, app as n, BrowserWindow as a } from "electron";
import o from "path";
import { fileURLToPath as w } from "url";
import { existsSync as p } from "fs";
const f = w(import.meta.url), i = o.dirname(f), s = process.env.NODE_ENV === "development" || !p(o.join(i, "../dist/index.html"));
let e = null;
function l() {
  e = new a({
    width: 600,
    height: 900,
    transparent: !0,
    frame: !1,
    alwaysOnTop: !0,
    resizable: !1,
    webPreferences: {
      preload: o.join(i, "preload.js"),
      contextIsolation: !0,
      nodeIntegration: !1,
      webSecurity: !s,
      backgroundThrottling: !1
    }
  }), s ? (e.loadURL("http://localhost:5174/electron/index.html"), e.webContents.openDevTools()) : e.loadFile(o.join(i, "../dist/index.html"));
}
r.handle("get-window-position", () => {
  if (!e) return { x: 0, y: 0 };
  const t = e.getPosition();
  return { x: t[0], y: t[1] };
});
r.handle("set-window-position", (t, d, h) => e ? (e.setBounds({ x: d, y: h, width: 600, height: 900 }), !0) : !1);
r.handle("get-window-bounds", () => e ? e.getBounds() : { width: 0, height: 0, x: 0, y: 0 });
n.whenReady().then(() => {
  l(), n.on("activate", () => {
    a.getAllWindows().length === 0 && l();
  });
});
n.on("window-all-closed", () => {
  process.platform !== "darwin" && n.quit();
});
