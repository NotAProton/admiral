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

type ResolveDebugEvent = {
  at: string;
  step: string;
  details?: Record<string, unknown>;
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
  const debugEvents: ResolveDebugEvent[] = [];

  const log = (step: string, details?: Record<string, unknown>): void => {
    const event: ResolveDebugEvent = {
      at: new Date().toISOString(),
      step,
      details
    };
    debugEvents.push(event);
    const line = details ? `${step} ${JSON.stringify(details)}` : step;
    console.log(`[resolver] ${line}`);
  };

  let browserClosed = false;

  const closeBrowser = async (browser: { close: () => Promise<void> }): Promise<void> => {
    if (browserClosed) return;
    browserClosed = true;
    await browser.close().catch(() => undefined);
  };

  const browser = await chromium.launch({
    headless: input.headless,
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  });

  captureUrls(context, seen);
  log("browser_launched", {
    headless: input.headless,
    lmsUrl: input.lmsUrl,
    classPageUrl: input.classPageUrl,
    joinLinkText: input.joinLinkText
  });

  context.on("response", async (response) => {
    const responseUrl = response.url();
    if (!responseUrl.includes("mod_bigbluebuttonbn") && !responseUrl.includes("bigbluebutton")) return;

    log("interesting_response_seen", { responseUrl });

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

    log("payload_urls_updated", { count: payloadUrls.length });
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

    if (!usernameInput || !passwordInput) {
      log("login_fields_missing", { currentUrl: page.url() });
      return false;
    }

    log("login_fields_found", { currentUrl: page.url() });
    await usernameInput.fill(input.username);
    await passwordInput.fill(input.password);
    await passwordInput.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    log("login_submitted", { currentUrl: page.url() });
    return true;
  };

  try {
    log("goto_lms_start", { url: input.lmsUrl });
    await page.goto(input.lmsUrl, { waitUntil: "domcontentloaded" });
    log("goto_lms_done", { finalUrl: page.url() });
    const didLoginOnLms = await tryLoginIfPresent();
    log("lms_login_attempt", { didLoginOnLms, currentUrl: page.url() });

    log("goto_class_page_start", { url: input.classPageUrl });
    await page.goto(input.classPageUrl, { waitUntil: "domcontentloaded" });
    log("goto_class_page_done", { finalUrl: page.url() });

    const didLoginAfterRedirect = await tryLoginIfPresent();
    log("class_page_login_attempt", { didLoginAfterRedirect, currentUrl: page.url() });
    if (didLoginAfterRedirect) {
      await page.goto(input.classPageUrl, { waitUntil: "domcontentloaded" });
      log("goto_class_page_after_login_done", { finalUrl: page.url() });
    }

    const joinTextRegex = new RegExp(escapeRegex(input.joinLinkText), "i");
    const popupPromise = context.waitForEvent("page", { timeout: 12_000 }).catch(() => null);
    log("click_join_attempt", { joinLinkText: input.joinLinkText, currentUrl: page.url() });
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

      log("click_join_failed", { currentUrl: page.url(), clickableCount: clickables.length });
      await page.screenshot({ path: `${input.runtimeDir}/resolve-no-join.png`, fullPage: true }).catch(() => undefined);
      await writeRuntimeFile(`${input.runtimeDir}/resolve-clickables.json`, JSON.stringify(clickables, null, 2));
      throw new Error(`Could not click join entry with text '${input.joinLinkText}'`);
    }

    log("click_join_succeeded", { currentUrl: page.url() });

    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      log("popup_detected", { popupUrl: popup.url() });
    } else {
      log("popup_not_detected", { currentUrl: page.url() });
    }

    await page.waitForTimeout(input.postClickWaitMs);
    log("post_click_wait_done", { waitMs: input.postClickWaitMs, currentUrl: page.url() });

    const allMainPageUrls = context.pages().map((p) => p.url()).filter((url) => url.startsWith("http"));
    for (const url of allMainPageUrls) {
      seen.push({ url, source: "page-url-snapshot", at: new Date().toISOString() });
    }

    const payloadCandidate = payloadUrls
      .filter((url) => /bigbluebutton|html5client|\/bbb|join|meeting/i.test(url))
      .at(-1) ?? null;

    const heuristicCandidate = chooseBbbCandidate(seen, input.lmsUrl);
    const joinUrl = normalizeUrl(payloadCandidate ?? heuristicCandidate ?? "");
    const authStatePath = `${input.runtimeDir}/auth-state.json`;

    log("join_url_candidates", {
      payloadCandidate,
      heuristicCandidate,
      resolvedJoinUrl: joinUrl,
      seenCount: seen.length,
      payloadCount: payloadUrls.length
    });

    await writeRuntimeFile(`${input.runtimeDir}/resolve-log.json`, JSON.stringify(seen, null, 2));
    await writeRuntimeFile(`${input.runtimeDir}/resolve-payload-urls.json`, JSON.stringify(payloadUrls, null, 2));
    await context.storageState({ path: authStatePath });

    if (!joinUrl) {
      throw new Error("No BBB-like URL detected while resolving join link");
    }

    await writeRuntimeFile(`${input.runtimeDir}/bbb-link.txt`, `${joinUrl}\n`);
    log("resolver_success", { joinUrl, authStatePath });
    return { joinUrl, authStatePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("resolver_error", { message, currentUrl: page.url() });
    throw error;
  } finally {
    await writeRuntimeFile(`${input.runtimeDir}/resolve-debug.json`, JSON.stringify(debugEvents, null, 2));
    await closeBrowser(browser);
  }
}
