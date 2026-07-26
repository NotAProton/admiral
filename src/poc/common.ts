import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function parseNumber(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
  }
  return null;
}

export async function clickByName(page: Page, re: RegExp): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: re }).first(),
    page.getByRole("link", { name: re }).first(),
    page.locator("button", { hasText: re }).first(),
    page.locator("a", { hasText: re }).first()
  ];

  for (const candidate of candidates) {
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      await candidate.click({ timeout: 8_000 });
      return true;
    }
  }

  return false;
}

export type SeenUrl = {
  url: string;
  source: string;
  at: string;
};

export function captureUrls(context: BrowserContext, seen: SeenUrl[]): void {
  const wirePage = (page: Page): void => {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        rememberUrl(seen, frame.url(), "framenavigated");
      }
    });

    page.on("request", (request) => {
      rememberUrl(seen, request.url(), "request");
    });

    page.on("response", (response) => {
      rememberUrl(seen, response.url(), "response");
    });
  };

  for (const page of context.pages()) {
    wirePage(page);
  }

  context.on("page", wirePage);
}

function rememberUrl(seen: SeenUrl[], url: string, source: string): void {
  if (!url.startsWith("http")) return;
  seen.push({
    url,
    source,
    at: new Date().toISOString()
  });
}

export async function writeRuntimeFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export function chooseBbbCandidate(seen: SeenUrl[], lmsUrl: string): string | null {
  if (seen.length === 0) return null;

  const lmsHost = new URL(lmsUrl).hostname;
  const scored = seen
    .map((entry, index) => {
      let score = 0;
      const url = entry.url.toLowerCase();
      const host = new URL(entry.url).hostname;

      if (url.includes("bigbluebutton") || url.includes("html5client") || url.includes("/bbb")) score += 6;
      if (url.includes("join") || url.includes("meeting")) score += 3;
      if (host !== lmsHost) score += 2;

      return { ...entry, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score === a.score ? b.index - a.index : b.score - a.score));

  return scored[0]?.url ?? null;
}
