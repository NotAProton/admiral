import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { clickByName, firstVisible, parseNumber, writeRuntimeFile } from "../poc/common.js";
import type { ActiveSlot, ParticipantSnapshot } from "../shared/types.js";

type JoinInput = {
  joinUrl: string;
  headless: boolean;
  authStatePath?: string;
  moodleUsername?: string;
  moodlePassword?: string;
  displayNameOverride?: string;
};

type MatchResult = {
  count: number;
  names: string[];
  panelText: string;
};

export class BbbSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async join(input: JoinInput): Promise<void> {
    await this.close();

    try {
      this.browser = await chromium.launch({
        headless: input.headless,
        args: [
          "--use-fake-ui-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-dev-shm-usage"
        ]
      });

      this.context = await this.browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 900 },
        ...(input.authStatePath ? { storageState: input.authStatePath } : {})
      });

      this.page = await this.context.newPage();

      await this.doJoinFlow(input);
    } catch (error) {
      // A failed join must not leave a zombie browser holding memory/CPU until
      // the next join attempt. Close everything, then rethrow so the engine
      // records the failure and applies its backoff. This covers launch/
      // newContext/newPage failures too, not just doJoinFlow.
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  private async doJoinFlow(input: JoinInput): Promise<void> {
    if (!this.page) throw new Error("Browser page not initialized");

    await this.page.goto(input.joinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (this.page.url().includes("/login/index.php") && input.moodleUsername && input.moodlePassword) {
      const usernameInput = await firstVisible(this.page, [
        "#username",
        "input[name='username']",
        "input[placeholder*='username' i]",
        "input[type='text']",
        "input[type='email']"
      ]);
      const passwordInput = await firstVisible(this.page, [
        "#password",
        "input[name='password']",
        "input[placeholder*='password' i]",
        "input[type='password']"
      ]);

      if (usernameInput && passwordInput) {
        await usernameInput.fill(input.moodleUsername);
        await passwordInput.fill(input.moodlePassword);
        await passwordInput.press("Enter");
        await this.page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
        await this.page.goto(input.joinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
    }

    if (input.displayNameOverride) {
      const nameInput = await firstVisible(this.page, [
        "input[name='username']",
        "input[aria-label*='name' i]",
        "input[placeholder*='name' i]"
      ]);
      if (nameInput) {
        await nameInput.fill(input.displayNameOverride);
      }
    }

    await clickByName(this.page, /join|enter|start/i).catch(() => false);
    await this.page.waitForTimeout(2_000);

    await this.trySelectListenOnly();
    await this.page.waitForTimeout(5_000);
    await this.openUserListPanel();

    // Verify we actually landed in a BBB room.  A silent join failure
    // (e.g. button click swallowed, redirect loop) would otherwise leave
    // the engine thinking it is InRoom when it is not.
    const currentUrl = this.page.url();
    if (!currentUrl.includes("html5client") && !currentUrl.includes("bigbluebutton")) {
      throw new Error(
        `Does not appear to be inside a BBB room after join attempt.  ` +
        `Current URL: ${currentUrl}`
      );
    }
  }

  async scrapeParticipants(targetDisplayName: string): Promise<ParticipantSnapshot> {
    if (!this.page) {
      return { count: 0, names: [], nameExactMatchCount: 0, scrapeOk: false };
    }

    await this.openUserListPanel();
    await this.page.waitForTimeout(1_000);

    const details = await this.page
      .evaluate(() => {
        const usersCountNode = document.querySelector("[data-test-users-count]") as HTMLElement | null;
        const usersCountText = usersCountNode?.innerText?.trim() ?? "";

        const names = Array.from(
          document.querySelectorAll("[data-test*='userListItem'], [data-test*='userList'] [role='listitem']")
        )
          .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((value) => value.length > 0);

        const panelText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();

        return {
          usersCountText,
          names,
          panelText
        };
      })
      .catch(() => null);

    // A failed evaluate means the client most likely fell out of the room
    // (navigation, crash). Report "unknown" via scrapeOk=false instead of a
    // fake zero count so the engine never mistakes it for an empty room.
    if (!details) {
      return { count: 0, names: [], nameExactMatchCount: 0, scrapeOk: false };
    }

    const textCount = parseNumber(details.usersCountText.match(/(\d+)/)?.[1], 0);
    const listCount = details.names.length;
    const count = Math.max(textCount, listCount);

    const normalize = (name: string): string => name.replace(/\(you\)/gi, "").replace(/\s+/g, " ").trim();
    const wanted = normalize(targetDisplayName);

    const matchCountFromNames = details.names
      .map((name) => normalize(name))
      .filter((name) => name === wanted).length;

    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const textRegex = new RegExp(escaped, "g");
    const matchCountFromText = (details.panelText.match(textRegex) ?? []).length;

    return {
      count,
      names: details.names,
      nameExactMatchCount: Math.max(matchCountFromNames, matchCountFromText),
      scrapeOk: true
    };
  }

  async leave(): Promise<void> {
    if (!this.page) return;

    await clickByName(this.page, /leave/i).catch(() => false);
    await this.page.waitForTimeout(1_000);
    await clickByName(this.page, /leave meeting|logout|confirm/i).catch(() => false);

    await this.close();
  }

  async saveProof(pathPrefix: string): Promise<void> {
    if (!this.page) return;

    await this.page.screenshot({ path: `${pathPrefix}-proof.png`, fullPage: true }).catch(() => undefined);
    await writeRuntimeFile(`${pathPrefix}-final-url.txt`, `${this.page.url()}\n`);
  }

  isActive(): boolean {
    return this.page != null;
  }

  private async trySelectListenOnly(): Promise<void> {
    if (!this.page) return;

    const clickByTextRegex = async (re: RegExp): Promise<boolean> => {
      const locator = this.page!.getByText(re).first();
      if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
        await locator.click({ timeout: 8_000 }).catch(() => undefined);
        return true;
      }
      return false;
    };

    let listenOnlyClicked = await clickByName(this.page, /listen\s*only|audio\s*only|headphones/i);
    if (!listenOnlyClicked) listenOnlyClicked = await clickByTextRegex(/listen\s*only/i);
    if (!listenOnlyClicked) {
      const locator = this.page.locator("[data-test*='listenOnly'], [aria-label*='Listen only' i]").first();
      if ((await locator.count()) > 0) {
        await locator.click({ timeout: 8_000, force: true }).catch(() => undefined);
      }
    }
  }

  private async openUserListPanel(): Promise<void> {
    if (!this.page) return;

    const selectors = [
      "[data-test='toggleUserList']",
      "[aria-label*='User list toggle' i]",
      "button[aria-label*='User list' i]"
    ];

    for (let i = 0; i < 3; i += 1) {
      for (const selector of selectors) {
        const locator = this.page.locator(selector).first();
        if ((await locator.count()) > 0) {
          await locator.click({ timeout: 5_000, force: true }).catch(() => undefined);
        }
      }

      const opened = await this.page
        .evaluate(() => {
          return Boolean(
            document.querySelector("[data-test*='userListContent']") ||
              document.querySelector("[data-test*='userListItem']") ||
              document.querySelector("[data-test-users-count]")
          );
        })
        .catch(() => false);

      if (opened) return;
      await this.page.waitForTimeout(800);
    }
  }

  private async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

export function runtimePrefixForSlot(slot: ActiveSlot): string {
  const safeCourse = slot.courseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `.runtime/worker/${safeCourse}-${timestamp}`;
}
