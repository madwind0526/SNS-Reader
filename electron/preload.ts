import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("snsReader", {
  clearSettings: () => ipcRenderer.invoke("settings:clear"),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  platform: process.platform,
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings)
});
