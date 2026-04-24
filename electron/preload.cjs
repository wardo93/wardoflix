// Preload — runs in an isolated world before the renderer boots.
// We expose only a tiny, typed surface (`window.wardoflixUpdater`) so the
// renderer never touches `ipcRenderer` or Node directly.
//
// Named `.cjs` because the main package is `"type": "module"` but
// Electron preload scripts must be CommonJS (classic `require`).

const { contextBridge, ipcRenderer } = require('electron')

const CHANNEL = 'updater:status'

// Access-control surface — read-only. The renderer can display the
// install ID (e.g. in the debug overlay) so a user who got blocked
// can send their ID to the owner for allowlisting. The check itself
// ran in main.js before the renderer loaded; there is no IPC path
// back into the check logic, so the renderer cannot bypass it.
contextBridge.exposeInMainWorld('wardoflixAccess', {
  getInfo: () => ipcRenderer.invoke('access:getInfo'),
})

contextBridge.exposeInMainWorld('wardoflixUpdater', {
  // Trigger a check right now. Returns the latest status snapshot.
  check: () => ipcRenderer.invoke('updater:check'),

  // Restart the app and install the downloaded installer.
  install: () => ipcRenderer.invoke('updater:install'),

  // Pull the current status (useful when the UI mounts after an event fired).
  getStatus: () => ipcRenderer.invoke('updater:getStatus'),

  // Subscribe to lifecycle events. Returns an unsubscribe function.
  onStatus: (cb) => {
    if (typeof cb !== 'function') return () => {}
    const listener = (_event, status) => {
      try { cb(status) } catch {}
    }
    ipcRenderer.on(CHANNEL, listener)
    return () => ipcRenderer.off(CHANNEL, listener)
  },
})
