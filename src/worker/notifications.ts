import type { ActiveSlot } from "../shared/types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const RATE_LIMIT_MAX_PER_MINUTE = 1;
const RATE_LIMIT_MAX_PER_15_MINUTES = 5;
const ONE_MINUTE_MS = 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const RATE_LIMIT_STATE_FILE = ".runtime/resend-rate-limit.json";

type RateLimitState = {
  sentAtMs: number[];
};

let rateLimitLock: Promise<void> = Promise.resolve();

async function withRateLimitLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = rateLimitLock;
  let release!: () => void;
  rateLimitLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function loadRateLimitState(): Promise<RateLimitState> {
  try {
    const raw = await readFile(RATE_LIMIT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as RateLimitState;
    if (!Array.isArray(parsed.sentAtMs)) return { sentAtMs: [] };
    return {
      sentAtMs: parsed.sentAtMs.filter((value) => Number.isFinite(value))
    };
  } catch {
    return { sentAtMs: [] };
  }
}

async function saveRateLimitState(state: RateLimitState): Promise<void> {
  await mkdir(dirname(RATE_LIMIT_STATE_FILE), { recursive: true });
  await writeFile(RATE_LIMIT_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function canSendAndRecordNow(nowMs: number): Promise<{ allowed: boolean; reason?: string }> {
  return withRateLimitLock(async () => {
    const state = await loadRateLimitState();

    state.sentAtMs = state.sentAtMs.filter((ts) => nowMs - ts <= FIFTEEN_MINUTES_MS);

    const inLastMinute = state.sentAtMs.filter((ts) => nowMs - ts <= ONE_MINUTE_MS).length;
    if (inLastMinute >= RATE_LIMIT_MAX_PER_MINUTE) {
      await saveRateLimitState(state);
      return { allowed: false, reason: "per-minute limit reached" };
    }

    const inLast15Minutes = state.sentAtMs.length;
    if (inLast15Minutes >= RATE_LIMIT_MAX_PER_15_MINUTES) {
      await saveRateLimitState(state);
      return { allowed: false, reason: "15-minute limit reached" };
    }

    state.sentAtMs.push(nowMs);
    await saveRateLimitState(state);
    return { allowed: true };
  });
}

function nowIstLabel(): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long"
  }).format(new Date());
}

async function sendResendEmail(subject: string, lines: string[]): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY ?? "";
  const resendFrom = process.env.RESEND_FROM ?? "";
  const resendTo = process.env.RESEND_TO ?? "";

  if (!resendKey || !resendFrom || !resendTo) {
    console.warn("Notification email skipped: RESEND_* env vars are missing.");
    return;
  }

  const nowMs = Date.now();
  const limit = await canSendAndRecordNow(nowMs);
  if (!limit.allowed) {
    console.warn(
      `Notification email rate-limited (${limit.reason}). Limits: ${RATE_LIMIT_MAX_PER_MINUTE}/min and ${RATE_LIMIT_MAX_PER_15_MINUTES}/15min.`
    );
    return;
  }

  const payload = {
    from: resendFrom,
    to: [resendTo],
    subject,
    text: lines.join("\n")
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    throw new Error(`Resend email failed: ${res.status} ${body}`);
  }
}

export async function sendJoinSuccessEmail(slot: ActiveSlot, joinUrl: string): Promise<void> {
  const nowIst = nowIstLabel();
  return sendResendEmail(`Admiral joined: ${slot.className}`, [
    "Admiral has successfully joined a class.",
    `Course: ${slot.className} (${slot.courseId})`,
    `Started slot: ${slot.startedAt} IST`,
    `Ended slot: ${slot.endsAt} IST`,
    `Join timestamp (IST): ${nowIst}`,
    `Join URL: ${joinUrl}`
  ]);
}

export async function sendJoinFailureEmail(slot: ActiveSlot, errorMessage: string): Promise<void> {
  const nowIst = nowIstLabel();
  return sendResendEmail(`Admiral join failed: ${slot.className}`, [
    "Admiral failed to join a class.",
    `Course: ${slot.className} (${slot.courseId})`,
    `Started slot: ${slot.startedAt} IST`,
    `Ended slot: ${slot.endsAt} IST`,
    `Failure timestamp (IST): ${nowIst}`,
    `Error: ${errorMessage}`
  ]);
}

export async function sendLeaveSuccessEmail(slot: ActiveSlot | null): Promise<void> {
  const nowIst = nowIstLabel();
  const courseLabel = slot ? `${slot.className} (${slot.courseId})` : "Unknown slot";
  return sendResendEmail("Admiral left meeting room", [
    "Admiral has left a meeting room.",
    `Course: ${courseLabel}`,
    `Leave timestamp (IST): ${nowIst}`
  ]);
}
