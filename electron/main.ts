import { app, BrowserWindow, ipcMain } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const settingsFilePath = path.resolve(process.cwd(), process.env.SNS_READER_SETTINGS_FILE ?? "data/runtime/app-settings.json");

ipcMain.handle("settings:load", async () => {
  try {
    const raw = await readFile(settingsFilePath, "utf8");

    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle("settings:save", async (_event, settings: unknown) => {
  await mkdir(path.dirname(settingsFilePath), { recursive: true });
  await writeFile(settingsFilePath, JSON.stringify(settings, null, 2), "utf8");

  return true;
});

ipcMain.handle("settings:clear", async () => {
  await rm(settingsFilePath, { force: true });

  return true;
});

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "SNS Reader",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  void win.loadFile(path.join(__dirname, "../dist/index.html"));
};

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
