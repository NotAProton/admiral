import type { ActiveSlot } from "../shared/types.js";

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
