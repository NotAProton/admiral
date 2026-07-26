import type { ActiveSlot } from "../shared/types.js";

export async function sendJoinSuccessEmail(slot: ActiveSlot, joinUrl: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY ?? "";
  const resendFrom = process.env.RESEND_FROM ?? "";
  const resendTo = process.env.RESEND_TO ?? "";

  if (!resendKey || !resendFrom || !resendTo) {
    console.warn("Join-success email skipped: RESEND_* env vars are missing.");
    return;
  }

  const nowIst = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long"
  }).format(new Date());

  const payload = {
    from: resendFrom,
    to: [resendTo],
    subject: `Admiral joined: ${slot.className}`,
    text: [
      "Admiral has successfully joined a class.",
      `Course: ${slot.className} (${slot.courseId})`,
      `Started slot: ${slot.startedAt} IST`,
      `Ended slot: ${slot.endsAt} IST`,
      `Join timestamp (IST): ${nowIst}`,
      `Join URL: ${joinUrl}`
    ].join("\n")
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
    throw new Error(`Resend join-success email failed: ${res.status} ${body}`);
  }
}
