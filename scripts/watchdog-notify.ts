import "dotenv/config";
import { dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const healthUrl = process.env.WATCHDOG_HEALTH_URL ?? "http://127.0.0.1:8080/health";
const resendKey = process.env.RESEND_API_KEY ?? "";
const resendFrom = process.env.RESEND_FROM ?? "";
const resendTo = process.env.RESEND_TO ?? "";
const minMinutesBetweenAlerts = Number(process.env.WATCHDOG_MIN_ALERT_MINUTES ?? 30);
const maxAlertsPerDay = Number(process.env.WATCHDOG_MAX_ALERTS_PER_DAY ?? 6);
const stateFile = process.env.WATCHDOG_STATE_FILE ?? ".runtime/watchdog-state.json";

type WatchdogState = {
  lastAlertAtMs: number;
  istDay: string;
  countForDay: number;
};

/** IST calendar date key "YYYY-MM-DD" — drives the daily alert cap. */
function istDateKey(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(epochMs));
}

/** Escalating spacing between alerts within one IST day (30m -> 2h -> 6h -> 12h). */
function alertSpacingMs(alertsToday: number, baseMinutes: number): number {
  const steps = [baseMinutes, 120, 360, 720];
  const idx = Math.min(alertsToday, steps.length - 1);
  return steps[idx] * 60 * 1000;
}

function loadState(): WatchdogState {
  if (!existsSync(stateFile)) {
    return { lastAlertAtMs: 0, istDay: "", countForDay: 0 };
  }

  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<WatchdogState>;
    return {
      lastAlertAtMs: parsed.lastAlertAtMs ?? 0,
      istDay: parsed.istDay ?? "",
      countForDay: parsed.countForDay ?? 0
    };
  } catch {
    return { lastAlertAtMs: 0, istDay: "", countForDay: 0 };
  }
}

function saveState(state: WatchdogState): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function healthOk(): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendAlert(message: string): Promise<void> {
  if (!resendKey || !resendFrom || !resendTo) {
    console.warn("Resend vars missing; watchdog alert suppressed.");
    return;
  }

  const payload = {
    from: resendFrom,
    to: [resendTo],
    subject: "Admiral watchdog alert",
    text: message
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<no-body>");
    throw new Error(`Resend API failed: ${res.status} ${body}`);
  }
}

function istLabel(epochMs: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long"
  }).format(new Date(epochMs));
}

async function main(): Promise<void> {
  const ok = await healthOk();
  if (ok) {
    console.log("Watchdog health check OK.");
    return;
  }

  const state = loadState();
  const nowMs = Date.now();
  const today = istDateKey(nowMs);
  if (state.istDay !== today) {
    state.istDay = today;
    state.countForDay = 0;
  }

  if (state.countForDay >= maxAlertsPerDay) {
    console.warn(`Health failed but daily alert cap (${maxAlertsPerDay}) reached.`);
    return;
  }

  const spacing = alertSpacingMs(state.countForDay, minMinutesBetweenAlerts);
  if (nowMs - state.lastAlertAtMs < spacing) {
    console.warn("Health failed but alert is rate-limited.");
    return;
  }

  const msg = `Admiral health check failed at ${istLabel(nowMs)} for ${healthUrl}`;
  await sendAlert(msg);

  await mkdir(dirname(stateFile), { recursive: true });
  state.lastAlertAtMs = nowMs;
  state.countForDay += 1;
  saveState(state);
  console.log(`Watchdog alert sent (${state.countForDay}/${maxAlertsPerDay} today).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
