import process from "node:process";
import {
  defaultLoginUrls,
  formatProfileHint,
  keepBrowserOpen,
  launchPersistentBrowser,
  loadAppSettings,
  loadEnv,
  parseArgs,
} from "./playwright-session.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv();
  const settings = await loadAppSettings(env);
  const urls = args.url ? [args.url] : defaultLoginUrls(settings);
  const { context, userDataDir, executablePath } = await launchPersistentBrowser({ env, args });
  const [firstUrl, ...restUrls] = urls;
  const firstPage = context.pages()[0] ?? (await context.newPage());

  await firstPage.goto(firstUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  for (const url of restUrls) {
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined);
  }

  console.log("SNS Reader login browser opened.");
  console.log(`Chrome: ${executablePath}`);
  console.log(`Profile: ${formatProfileHint(userDataDir)}`);
  console.log("Log in to the SNS accounts, then close this browser window when you are done.");

  await keepBrowserOpen(context);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
