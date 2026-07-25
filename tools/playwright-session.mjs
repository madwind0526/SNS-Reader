import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const DEFAULT_SETTINGS_FILE = "./data/runtime/app-settings.json";
const DEFAULT_BROWSER_PROFILE_DIR = "./data/runtime/browser-profile";

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }

  return args;
}

export function parseEnv(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        const key = index >= 0 ? line.slice(0, index).trim() : line;
        const value = index >= 0 ? line.slice(index + 1).trim() : "";

        return [key, value.replace(/^["']|["']$/g, "")];
      })
  );
}

export async function loadEnv() {
  const fileEnv = await readFile(path.join(workspaceRoot, ".env"), "utf8")
    .then(parseEnv)
    .catch(() => ({}));

  return {
    ...fileEnv,
    ...process.env,
  };
}

export async function loadAppSettings(env) {
  const settingsPath = path.resolve(workspaceRoot, env.SNS_READER_SETTINGS_FILE || DEFAULT_SETTINGS_FILE);

  return readFile(settingsPath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
}

export function resolveBrowserProfileDir(env, args = {}) {
  return path.resolve(
    workspaceRoot,
    args["user-data-dir"] ||
      env.SNS_READER_BROWSER_USER_DATA_DIR ||
      env.SNS_BROWSER_USER_DATA_DIR ||
      DEFAULT_BROWSER_PROFILE_DIR
  );
}

export function findChromeExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.SNS_READER_CHROME_PATH,
          process.env.CHROME_PATH,
          path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            process.env.SNS_READER_CHROME_PATH,
            process.env.CHROME_PATH,
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            process.env.SNS_READER_CHROME_PATH,
            process.env.CHROME_PATH,
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/usr/bin/microsoft-edge",
          ];

  return candidates.filter(Boolean).find((candidate) => existsSync(candidate)) || "";
}

export function defaultLoginUrls(settings) {
  const accounts = Array.isArray(settings?.accounts) ? settings.accounts : [];
  const loginCapable = new Set(["facebook", "instagram", "threads", "youtube", "naver-blog", "x"]);
  const urls = accounts
    .filter((account) => loginCapable.has(account.platform) && account.url)
    .map((account) => account.url);

  return urls.length ? [...new Set(urls)] : ["https://www.facebook.com/", "https://www.instagram.com/", "https://www.youtube.com/"];
}

export async function launchPersistentBrowser({ env, args = {}, headless = false }) {
  const { chromium } = await import("playwright-core");
  const userDataDir = resolveBrowserProfileDir(env, args);
  const executablePath = args["chrome-path"] || env.SNS_READER_CHROME_PATH || findChromeExecutable();

  if (!executablePath) {
    throw new Error("Chrome 실행 파일을 찾지 못했습니다. .env의 SNS_READER_CHROME_PATH에 chrome.exe 경로를 지정하세요.");
  }

  await mkdir(userDataDir, { recursive: true });

  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless,
      viewport: { width: 1280, height: 900 },
      locale: "ko-KR",
      timezoneId: process.env.TZ || "Asia/Seoul",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (/ProcessSingleton|user data directory|profile|already in use|lock/i.test(message)) {
      throw new Error("로그인 브라우저가 이미 열려 있습니다. 로그인 후 그 창을 닫고 Update를 다시 실행하세요.");
    }

    throw error;
  }

  return { context, userDataDir, executablePath };
}

export async function keepBrowserOpen(context) {
  await new Promise((resolve) => {
    context.on("close", resolve);
  });
}

export function formatProfileHint(userDataDir) {
  return path.relative(workspaceRoot, userDataDir) || userDataDir;
}

export function defaultTempDir() {
  return path.join(os.tmpdir(), "sns-reader");
}
