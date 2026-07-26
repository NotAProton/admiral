import { chromium } from "playwright";
import {
  captureUrls,
  chooseBbbCandidate,
  clickByName,
  escapeRegex,
  firstVisible,
  type SeenUrl,
  writeRuntimeFile
} from "../poc/common.js";

export type ResolveJoinInput = {
  lmsUrl: string;
  username?: string;
  password?: string;
  classPageUrl: string;
  joinLinkText: string;
  headless: boolean;
  postClickWaitMs: number;
  runtimeDir: string;
};

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

export async function resolveJoinUrl(input: ResolveJoinInput): Promise<{ joinUrl: string; authStatePath: string }> {
  const seen: SeenUrl[] = [];
  const payloadUrls: string[] = [];

  const browser = await chromium.launch({
    headless: input.headless,
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  });

  captureUrls(context, seen);

  context.on("response", async (response) => {
    const responseUrl = response.url();
    if (!responseUrl.includes("mod_bigbluebuttonbn") && !responseUrl.includes("bigbluebutton")) return;

    const bodyText = await response.text().catch(() => "");
    if (!bodyText) return;

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
      // Non-JSON payload.
    }
  });

  const page = await context.newPage();

  const tryLoginIfPresent = async (): Promise<boolean> => {
    if (!input.username || !input.password) return false;

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

    if (!usernameInput || !passwordInput) return false;

    await usernameInput.fill(input.username);
    await passwordInput.fill(input.password);
    await passwordInput.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    return true;
  };

  await page.goto(input.lmsUrl, { waitUntil: "domcontentloaded" });
  await tryLoginIfPresent();

  await page.goto(input.classPageUrl, { waitUntil: "domcontentloaded" });
  const didLoginAfterRedirect = await tryLoginIfPresent();
  if (didLoginAfterRedirect) {
    await page.goto(input.classPageUrl, { waitUntil: "domcontentloaded" });
  }

  const joinTextRegex = new RegExp(escapeRegex(input.joinLinkText), "i");
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

    await page.screenshot({ path: `${input.runtimeDir}/resolve-no-join.png`, fullPage: true }).catch(() => undefined);
    await writeRuntimeFile(`${input.runtimeDir}/resolve-clickables.json`, JSON.stringify(clickables, null, 2));
    await browser.close();
    throw new Error(`Could not click join entry with text '${input.joinLinkText}'`);
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  }

  await page.waitForTimeout(input.postClickWaitMs);

  const allMainPageUrls = context.pages().map((p) => p.url()).filter((url) => url.startsWith("http"));
  for (const url of allMainPageUrls) {
    seen.push({ url, source: "page-url-snapshot", at: new Date().toISOString() });
  }

  const payloadCandidate = payloadUrls
    .filter((url) => /bigbluebutton|html5client|\/bbb|join|meeting/i.test(url))
    .at(-1) ?? null;

  const joinUrl = normalizeUrl(payloadCandidate ?? chooseBbbCandidate(seen, input.lmsUrl) ?? "");
  const authStatePath = `${input.runtimeDir}/auth-state.json`;

  await writeRuntimeFile(`${input.runtimeDir}/resolve-log.json`, JSON.stringify(seen, null, 2));
  await writeRuntimeFile(`${input.runtimeDir}/resolve-payload-urls.json`, JSON.stringify(payloadUrls, null, 2));
  await context.storageState({ path: authStatePath });

  await browser.close();

  if (!joinUrl) {
    throw new Error("No BBB-like URL detected while resolving join link");
  }

  await writeRuntimeFile(`${input.runtimeDir}/bbb-link.txt`, `${joinUrl}\n`);
  return { joinUrl, authStatePath };
}
