import "dotenv/config";
import { chromium } from "playwright";
import { z } from "zod";
import {
  captureUrls,
  chooseBbbCandidate,
  clickByName,
  escapeRegex,
  firstVisible,
  parseBoolean,
  parseNumber,
  type SeenUrl,
  writeRuntimeFile
} from "./common.js";

const envSchema = z.object({
  LMS_URL: z.string().url(),
  MOODLE_USERNAME: z.string().optional(),
  MOODLE_PASSWORD: z.string().optional(),
  CLASS_PAGE_URL: z.string().url().optional(),
  JOIN_LINK_TEXT: z.string().default("Join Online Class"),
  HEADLESS: z.string().optional(),
  KEEP_BROWSER_OPEN: z.string().optional(),
  POST_CLICK_WAIT_MS: z.string().optional()
});

const env = envSchema.parse(process.env);

const headless = parseBoolean(env.HEADLESS, true);
const keepOpen = parseBoolean(env.KEEP_BROWSER_OPEN, false);
const postClickWaitMs = parseNumber(env.POST_CLICK_WAIT_MS, 20_000);

const seen: SeenUrl[] = [];
const payloadUrls: string[] = [];

function extractUrls(text: string): string[] {
  const direct = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const escaped = text.match(/https?:\\\/\\\/[^\s"'<>]+/g) ?? [];
  return [...direct, ...escaped].map((value) => value.replace(/\\\//g, "/"));
}

function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectStringValues(nested, out);
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/&amp;/gi, "&");
}

async function tryLoginIfPresent(): Promise<boolean> {
  if (!env.MOODLE_USERNAME || !env.MOODLE_PASSWORD) {
    return false;
  }

  const usernameInput = await firstVisible(page, [
    "#username",
    "input[name='username']",
    "input[placeholder*='username' i]",
    "input[placeholder*='email' i]",
    "input[type='email']",
    "input[type='text']"
  ]);
  const passwordInput = await firstVisible(page, [
    "#password",
    "input[name='password']",
    "input[placeholder*='password' i]",
    "input[type='password']"
  ]);

  if (!usernameInput || !passwordInput) {
    return false;
  }

  await usernameInput.fill(env.MOODLE_USERNAME);
  await passwordInput.fill(env.MOODLE_PASSWORD);
  await passwordInput.press("Enter");

  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  return true;
}

const browser = await chromium.launch({
  headless,
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
});

const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
});

captureUrls(context, seen);

context.on("response", async (response) => {
  const responseUrl = response.url();
  if (!responseUrl.includes("mod_bigbluebuttonbn") && !responseUrl.includes("bigbluebutton")) {
    return;
  }

  const bodyText = await response.text().catch(() => "");
  if (!bodyText) {
    return;
  }

  for (const url of extractUrls(bodyText)) {
    if (!payloadUrls.includes(url)) payloadUrls.push(url);
  }

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const strings: string[] = [];
    collectStringValues(parsed, strings);
    for (const value of strings) {
      for (const url of extractUrls(value)) {
        if (!payloadUrls.includes(url)) payloadUrls.push(url);
      }
    }
  } catch {
    // Non-JSON responses are expected for some assets/endpoints.
  }
});

const page = await context.newPage();

console.log("Opening LMS...");
await page.goto(env.LMS_URL, { waitUntil: "domcontentloaded" });

if (env.MOODLE_USERNAME && env.MOODLE_PASSWORD) {
  console.log("Attempting Moodle login with provided env credentials...");
  const didLogin = await tryLoginIfPresent();
  if (!didLogin) {
    console.warn("Login fields not found on landing page. Continuing in case of SSO or existing session.");
  }
} else {
  console.log("MOODLE_USERNAME / MOODLE_PASSWORD not set. Proceeding without auto-login.");
}

if (env.CLASS_PAGE_URL) {
  console.log("Opening class page URL...");
  await page.goto(env.CLASS_PAGE_URL, { waitUntil: "domcontentloaded" });

  const didLoginAfterRedirect = await tryLoginIfPresent();
  if (didLoginAfterRedirect) {
    console.log("Login form detected during class-page redirect; login submitted.");
    await page.goto(env.CLASS_PAGE_URL, { waitUntil: "domcontentloaded" });
  }
}

const joinTextRegex = new RegExp(escapeRegex(env.JOIN_LINK_TEXT), "i");

console.log(`Trying to click join entry text: ${env.JOIN_LINK_TEXT}`);
const popupPromise = context.waitForEvent("page", { timeout: 12_000 }).catch(() => null);
const clicked = await clickByName(page, joinTextRegex);

if (!clicked) {
  const clickables = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("a,button,[role='button']"));
      return nodes
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => text.length > 0)
        .slice(0, 200);
    })
    .catch(() => [] as string[]);

  await page.screenshot({ path: ".runtime/resolve-no-join.png", fullPage: true }).catch(() => undefined);
  await writeRuntimeFile(".runtime/resolve-clickables.json", JSON.stringify(clickables, null, 2));

  throw new Error(
    `Could not click join entry using text '${env.JOIN_LINK_TEXT}'. Saved debug artifacts to .runtime/resolve-no-join.png and .runtime/resolve-clickables.json.`
  );
}

const popup = await popupPromise;
if (popup) {
  await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
}

await page.waitForTimeout(postClickWaitMs);

const allMainPageUrls = context.pages().map((p) => p.url()).filter((url) => url.startsWith("http"));
for (const url of allMainPageUrls) {
  seen.push({ url, source: "page-url-snapshot", at: new Date().toISOString() });
}

const payloadCandidate = payloadUrls
  .filter((url) => /bigbluebutton|html5client|\/bbb|join|meeting/i.test(url))
  .at(-1) ?? null;

const candidate = normalizeUrl(payloadCandidate ?? chooseBbbCandidate(seen, env.LMS_URL) ?? "");

await writeRuntimeFile(".runtime/resolve-log.json", JSON.stringify(seen, null, 2));
await writeRuntimeFile(".runtime/resolve-payload-urls.json", JSON.stringify(payloadUrls, null, 2));
await context.storageState({ path: ".runtime/auth-state.json" });

if (!candidate) {
  throw new Error("No BBB-like URL detected from network/navigation logs. Please walk me through your exact click flow and redirect chain.");
}

await writeRuntimeFile(".runtime/bbb-link.txt", `${candidate}\n`);
console.log(`Resolved BBB URL: ${candidate}`);
console.log("Saved to .runtime/bbb-link.txt, .runtime/resolve-log.json, and .runtime/auth-state.json");

if (!keepOpen) {
  await browser.close();
}
