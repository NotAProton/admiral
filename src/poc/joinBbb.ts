import "dotenv/config";
import { access, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { z } from "zod";
import {
  clickByName,
  firstVisible,
  parseBoolean,
  parseNumber,
  writeRuntimeFile
} from "./common.js";

const optionalUrl = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}, z.string().url().optional());

const envSchema = z.object({
  BBB_JOIN_URL: optionalUrl,
  DISPLAY_NAME: z.string().optional(),
  MOODLE_USERNAME: z.string().optional(),
  MOODLE_PASSWORD: z.string().optional(),
  HEADLESS: z.string().optional(),
  JOIN_HOLD_SECONDS: z.string().optional()
});

const env = envSchema.parse(process.env);

const headless = parseBoolean(env.HEADLESS, true);
const holdSeconds = parseNumber(env.JOIN_HOLD_SECONDS, 45);

async function getJoinUrl(): Promise<string> {
  if (env.BBB_JOIN_URL) return env.BBB_JOIN_URL;

  const fromRuntime = (await readFile(".runtime/bbb-link.txt", "utf8")).trim();
  if (!fromRuntime) {
    throw new Error("BBB_JOIN_URL is missing and .runtime/bbb-link.txt is empty.");
  }
  return fromRuntime;
}

async function clickByTextRegex(page: import("playwright").Page, re: RegExp): Promise<boolean> {
  const locator = page.getByText(re).first();
  if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
    await locator.click({ timeout: 8_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

async function clickByTextViaDom(page: import("playwright").Page, re: RegExp): Promise<boolean> {
  const pattern = re.source;
  return page
    .evaluate((rawPattern) => {
      const matcher = new RegExp(rawPattern, "i");
      const candidates = Array.from(
        document.querySelectorAll("button,[role='button'],a,span,div")
      ) as HTMLElement[];

      for (const node of candidates) {
        const text = (node.textContent ?? "").trim();
        if (!text || !matcher.test(text)) continue;

        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        node.click();
        return true;
      }

      return false;
    }, pattern)
    .catch(() => false);
}

async function clickFirstVisibleSelector(
  page: import("playwright").Page,
  selectors: string[],
  force = false
): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      const ok = await locator.click({ timeout: 8_000, force }).then(
        () => true,
        () => false
      );
      if (ok) return true;
    }
  }
  return false;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type ParticipantSnapshot = {
  usersLabelText: string | null;
  usersCountAttr: string | null;
  usersWithAudioAttr: string | null;
  usersCountFromBodyText: number | null;
  listCounts: Record<string, number>;
  sampleNames: string[];
  dataTestHints: string[];
  allDataTests: string[];
  visibleButtonTexts: string[];
  frameUrls: string[];
  toggleState: {
    exists: boolean;
    ariaPressed: string | null;
    ariaExpanded: string | null;
    className: string | null;
  };
};

function firstNumber(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

async function captureParticipantSnapshot(page: import("playwright").Page): Promise<ParticipantSnapshot> {
  const listSelectors = [
    "[data-test*='usersList'] [role='listitem']",
    "[data-test*='userList'] [role='listitem']",
    "[class*='userList'] [role='listitem']",
    "[class*='usersList'] [role='listitem']",
    "[data-test='userListItem']",
    "[data-test*='userListItem']",
    "[data-test*='usersListItem']",
    "[data-test*='userlist-item']",
    "[data-test*='userName']",
    "[class*='userName']",
    "[class*='userItem']",
    "[data-test*='user-item']",
    "[data-test*='users-item']"
  ];

  const listCounts: Record<string, number> = {};
  for (const selector of listSelectors) {
    listCounts[selector] = await page.locator(selector).count().catch(() => 0);
  }

  const details = await page
    .evaluate(() => {
      const usersCountNode = document.querySelector("[data-test-users-count]");
      const usersWithAudioNode = document.querySelector("[data-test-users-with-audio-count]");

      const usersLabel =
        (document.querySelector("[data-test-users-count]") as HTMLElement | null)?.innerText?.trim() ??
        (document.querySelector("[aria-label*='Users' i]") as HTMLElement | null)?.innerText?.trim() ??
        null;

      const bodyText = document.body?.innerText ?? "";
      const bodyMatch = bodyText.match(/(?:Users|Participants|Attendees)\s*\((\d+)\)/i);

      const sampleNames = Array.from(document.querySelectorAll("[role='listitem']"))
        .map((node) => (node.textContent ?? "").trim())
        .filter((text) => text.length >= 2)
        .slice(0, 15);

      if (sampleNames.length === 0) {
        const altNames = Array.from(
          document.querySelectorAll(
            "[data-test*='userListItem'],[data-test*='userName'],[class*='userName'],[class*='userItem']"
          )
        )
          .map((node) => (node.textContent ?? "").trim())
          .filter((text) => text.length >= 2)
          .slice(0, 15);
        sampleNames.push(...altNames);
      }

      const dataTestHints = Array.from(document.querySelectorAll("[data-test]"))
        .map((node) => node.getAttribute("data-test") ?? "")
        .filter((value) => /user|participant|audio|listen|attendee/i.test(value))
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .slice(0, 80);

      const allDataTests = Array.from(document.querySelectorAll("[data-test]"))
        .map((node) => node.getAttribute("data-test") ?? "")
        .filter((value) => value.length > 0)
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .slice(0, 200);

      const visibleButtonTexts = Array.from(
        document.querySelectorAll("button,[role='button'],a,[data-test-users-count]")
      )
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 0)
        .filter((text, index, arr) => arr.indexOf(text) === index)
        .slice(0, 80);

      const toggleNode = document.querySelector("[data-test='toggleUserList']") as HTMLElement | null;

      return {
        usersLabelText: usersLabel,
        usersCountAttr: usersCountNode?.getAttribute("data-test-users-count") ?? null,
        usersWithAudioAttr: usersWithAudioNode?.getAttribute("data-test-users-with-audio-count") ?? null,
        usersCountFromBodyText: bodyMatch ? Number(bodyMatch[1]) : null,
        sampleNames,
        dataTestHints,
        allDataTests,
        visibleButtonTexts,
        toggleState: {
          exists: Boolean(toggleNode),
          ariaPressed: toggleNode?.getAttribute("aria-pressed") ?? null,
          ariaExpanded: toggleNode?.getAttribute("aria-expanded") ?? null,
          className: toggleNode?.className ?? null
        }
      };
    })
    .catch(() => ({
      usersLabelText: null,
      usersCountAttr: null,
      usersWithAudioAttr: null,
      usersCountFromBodyText: null,
      sampleNames: [] as string[],
      dataTestHints: [] as string[],
      allDataTests: [] as string[],
      visibleButtonTexts: [] as string[],
      toggleState: {
        exists: false,
        ariaPressed: null,
        ariaExpanded: null,
        className: null
      }
    }));

  return {
    ...details,
    listCounts,
    frameUrls: page.frames().map((frame) => frame.url())
  };
}

async function openUserListPanel(page: import("playwright").Page): Promise<boolean> {
  const attemptSelectors = async (): Promise<boolean> => {
    return (
      (await clickFirstVisibleSelector(
        page,
        [
          "[data-test='toggleUserList']",
          "[aria-label*='User list toggle' i]",
          "button[aria-label*='User list' i]"
        ],
        true
      )) ||
      (await clickByName(page, /user\s*list\s*toggle/i).catch(() => false))
    );
  };

  const attemptDom = async (): Promise<boolean> => {
    return page
      .evaluate(() => {
        const node = document.querySelector("[data-test='toggleUserList']") as HTMLElement | null;
        if (!node) return false;
        node.click();
        return true;
      })
      .catch(() => false);
  };

  for (let i = 0; i < 3; i += 1) {
    const selectorClicked = await attemptSelectors();
    const domClicked = selectorClicked ? false : await attemptDom();

    if (!selectorClicked && !domClicked) {
      await page.keyboard.press("u").catch(() => undefined);
    }

    await page.waitForTimeout(1_200);
    const opened = await page
      .evaluate(() => {
        const hasPanel =
          document.querySelector("[data-test*='userListContent']") ||
          document.querySelector("[data-test*='userListItem']") ||
          document.querySelector("[class*='userListContent']") ||
          document.querySelector("[class*='userListItem']");

        if (hasPanel) return true;

        const bodyText = document.body?.innerText ?? "";
        return /(?:Users|Participants|Attendees)\s*\(\d+\)/i.test(bodyText);
      })
      .catch(() => false);

    if (opened) return true;
  }

  return false;
}

const joinUrl = await getJoinUrl();

const browser = await chromium.launch({
  headless,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-dev-shm-usage"
  ]
});

const storageStatePath = ".runtime/auth-state.json";
const useStorageState = await fileExists(storageStatePath);

const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
  ...(useStorageState ? { storageState: storageStatePath } : {})
});

const page = await context.newPage();

console.log("Opening BBB join URL...");
await page.goto(joinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

if (page.url().includes("/login/index.php") && env.MOODLE_USERNAME && env.MOODLE_PASSWORD) {
  const usernameInput = await firstVisible(page, [
    "#username",
    "input[name='username']",
    "input[placeholder*='username' i]",
    "input[type='text']",
    "input[type='email']"
  ]);
  const passwordInput = await firstVisible(page, [
    "#password",
    "input[name='password']",
    "input[placeholder*='password' i]",
    "input[type='password']"
  ]);

  if (usernameInput && passwordInput) {
    console.log("Login required for join; submitting Moodle credentials...");
    await usernameInput.fill(env.MOODLE_USERNAME);
    await passwordInput.fill(env.MOODLE_PASSWORD);
    await passwordInput.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.goto(joinUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
}

if (env.DISPLAY_NAME) {
  const nameInput = await firstVisible(page, [
    "input[name='username']",
    "input[aria-label*='name' i]",
    "input[placeholder*='name' i]"
  ]);

  if (nameInput) {
    await nameInput.fill(env.DISPLAY_NAME);
  }
}

await clickByName(page, /join|enter|start/i).catch(() => false);
await page.waitForTimeout(2_000);

let listenOnlyClicked = await clickByName(page, /listen\s*only|audio\s*only|headphones/i);
if (!listenOnlyClicked) {
  listenOnlyClicked = await clickByTextRegex(page, /listen\s*only/i);
}
if (!listenOnlyClicked) {
  listenOnlyClicked = await clickByTextViaDom(page, /listen\s*only|audio\s*only/i);
}
if (!listenOnlyClicked) {
  listenOnlyClicked = await clickFirstVisibleSelector(
    page,
    [
      "[data-test*='listenOnly']",
      "[data-test*='listen-only']",
      "button:has-text('Listen only')",
      "[aria-label*='Listen only' i]"
    ],
    true
  );
}
if (!listenOnlyClicked) {
  console.warn("Listen-only button was not found with generic selectors. This may be expected for some BBB flows.");
}

await page.waitForTimeout(8_000);
await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
const modalStillOpen =
  (await page.locator(".ReactModal__Overlay--after-open").count().catch(() => 0)) > 0;

if (modalStillOpen) {
  await clickFirstVisibleSelector(page, ["[aria-label*='close' i]", "button:has-text('Close')"], true).catch(() => false);
}

const openedParticipants =
  (await openUserListPanel(page)) ||
  (await clickByName(page, /participants|attendees|users/i).catch(() => false)) ||
  (await clickByTextRegex(page, /participants|attendees|users/i)) ||
  (await clickByTextViaDom(page, /participants|attendees|users/i));
if (!openedParticipants) {
  await page.locator("[aria-label*='user' i], [aria-label*='participant' i]").first().click().catch(() => undefined);
}

await page.waitForTimeout(3_000);

const participantSnapshot = await captureParticipantSnapshot(page);

let participantCount = 0;
for (const value of Object.values(participantSnapshot.listCounts)) {
  participantCount = Math.max(participantCount, value);
}

participantCount = Math.max(
  participantCount,
  firstNumber(participantSnapshot.usersLabelText) ?? 0,
  firstNumber(participantSnapshot.usersCountAttr) ?? 0,
  firstNumber(participantSnapshot.usersWithAudioAttr) ?? 0,
  participantSnapshot.usersCountFromBodyText ?? 0
);

await page.screenshot({ path: ".runtime/join-proof.png", fullPage: true });

const joinSummary = {
  joinedAt: new Date().toISOString(),
  joinUrl,
  finalUrl: page.url(),
  listenOnlyClicked,
  participantCount,
  holdSeconds,
  participantSnapshot
};

await writeRuntimeFile(".runtime/join-log.json", JSON.stringify(joinSummary, null, 2));

console.log(`Join summary: ${JSON.stringify(joinSummary, null, 2)}`);
console.log("Saved proof to .runtime/join-proof.png and .runtime/join-log.json");

if (holdSeconds > 0) {
  console.log(`Holding session for ${holdSeconds}s before exit...`);
  await page.waitForTimeout(holdSeconds * 1_000);
}

await browser.close();
