import "dotenv/config";
import { dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const healthUrl = process.env.WATCHDOG_HEALTH_URL ?? "http://127.0.0.1:8080/health";
const resendKey = process.env.RESEND_API_KEY ?? "";
const resendFrom = process.env.RESEND_FROM ?? "";
const resendTo = process.env.RESEND_TO ?? "";
const minMinutesBetweenAlerts = Number(process.env.WATCHDOG_MIN_ALERT_MINUTES ?? 30);
const stateFile = process.env.WATCHDOG_STATE_FILE ?? ".runtime/watchdog-state.json";

type WatchdogState = {
  lastAlertAtMs: number;
};

function loadState(): WatchdogState {
  if (!existsSync(stateFile)) {
    return { lastAlertAtMs: 0 };
  }

  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as WatchdogState;
  } catch {
    return { lastAlertAtMs: 0 };
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

async function main(): Promise<void> {
  const ok = await healthOk();
  if (ok) {
    console.log("Watchdog health check OK.");
    return;
  }

  const state = loadState();
  const nowMs = Date.now();
  const minDeltaMs = minMinutesBetweenAlerts * 60 * 1000;

  if (nowMs - state.lastAlertAtMs < minDeltaMs) {
    console.warn("Health failed but alert is rate-limited.");
    return;
  }

  const msg = `Admiral health check failed at ${new Date(nowMs).toISOString()} for ${healthUrl}`;
  await sendAlert(msg);

  await mkdir(dirname(stateFile), { recursive: true });
  state.lastAlertAtMs = nowMs;
  saveState(state);
  console.log("Watchdog alert sent.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
