let lastStatus = null;
let eventSource = null;
let heartbeatTimer = null;
let countdownTimer = null;
let sseReconnectDelay = 3000;

const statusPre = document.getElementById("statusPre");
const hbState = document.getElementById("hbState");
const loginCard = document.getElementById("loginCard");
const appCard = document.getElementById("appCard");
const tokenInput = document.getElementById("tokenInput");
const siteTime = document.getElementById("siteTime");
const upcomingClass = document.getElementById("upcomingClass");
const schedulePre = document.getElementById("schedulePre");
const errorBanner = document.getElementById("errorBanner");
const sessionStanddownPill = document.getElementById("sessionStanddownPill");
const cancelSessionStanddownBtn = document.getElementById("cancelSessionStanddownBtn");
const historyList = document.getElementById("historyList");
const historyMoreBtn = document.getElementById("historyMoreBtn");

let historyTimer = null;
let historyOldestId = null;

// ── Utility ────────────────────────────────────────────────────────────────

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    lockUi();
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${path} failed with ${res.status}`);
  }

  return res.json();
}

function showError(message, durationMs = 6000) {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
  setTimeout(() => {
    errorBanner.style.display = "none";
  }, durationMs);
}

function setButtonBusy(btn, busy) {
  if (busy) {
    btn.dataset.origLabel = btn.textContent;
    btn.textContent = "…";
    btn.disabled = true;
    btn.classList.add("busy");
  } else {
    btn.textContent = btn.dataset.origLabel ?? btn.textContent;
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

// ── UI state ───────────────────────────────────────────────────────────────

function lockUi() {
  loginCard.classList.remove("hidden");
  appCard.classList.add("hidden");
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function unlockUi() {
  loginCard.classList.add("hidden");
  appCard.classList.remove("hidden");
}

// ── Countdown rendering (no network, uses cached status) ──────────────────

function formatDuration(totalSeconds) {
  if (totalSeconds <= 0) return "now";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderCountdown() {
  if (!lastStatus) return;

  const now = Date.now();

  // IST time pill (updated every second locally)
  const istStr = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  siteTime.textContent = `IST: ${istStr}`;

  // Active class countdown (time remaining in slot)
  const classTimeEl = document.getElementById("statClassTime");
  if (lastStatus.activeSlot) {
    const endsAt = new Date(lastStatus.activeSlot.endsAt).getTime();
    const remaining = Math.max(0, Math.round((endsAt - now) / 1000));
    if (classTimeEl) classTimeEl.textContent = `Ends in ${formatDuration(remaining)}`;
  }

  // Next class countdown
  const countdownEl = document.getElementById("statCountdown");
  const countdownClassEl = document.getElementById("statCountdownClass");
  if (lastStatus.upcomingSlot) {
    const startsAt = new Date(lastStatus.upcomingSlot.startedAt).getTime();
    const until = Math.max(0, Math.round((startsAt - now) / 1000));
    if (countdownEl) countdownEl.textContent = formatDuration(until);
    if (countdownClassEl) countdownClassEl.textContent = lastStatus.upcomingSlot.className;
  } else {
    if (countdownEl) countdownEl.textContent = "--";
    if (countdownClassEl) countdownClassEl.textContent = "No upcoming class";
  }

  // Join backoff remaining
  if (lastStatus.joinBackoffActive && lastStatus.joinBackoffRemainingSeconds != null) {
    const statReasonEl = document.getElementById("statReason");
    if (statReasonEl && !statReasonEl.textContent.includes("backoff")) {
      // don't stomp SSE-driven reason, only append backoff timer
    }
    const remaining = Math.max(0, lastStatus.joinBackoffRemainingSeconds - Math.round((now - new Date(lastStatus.updatedAt).getTime()) / 1000));
    const backoffEl = document.getElementById("statReason");
    if (backoffEl && lastStatus.joinBackoffActive) {
      backoffEl.textContent = `Backing off — resumes in ${formatDuration(remaining)}`;
    }
  }
}

// ── Status rendering ───────────────────────────────────────────────────────

const STATE_COLORS = {
  Out: "var(--muted)",
  Joining: "var(--warn)",
  InRoom: "var(--ok)",
  Leaving: "var(--danger)"
};

function renderStatus(status) {
  lastStatus = status;
  statusPre.textContent = JSON.stringify(status, null, 2);
  schedulePre.textContent = JSON.stringify(status.schedule, null, 2);

  const age = status.lastHeartbeatAgeSeconds;
  const fresh = status.heartbeatFresh;
  hbState.textContent = age == null ? "Heartbeat: none yet" : `Heartbeat: ${age}s ago`;
  hbState.className = `pill ${fresh ? "ok" : "warn"}`;

  // State summary card
  const statStateEl = document.getElementById("statState");
  if (statStateEl) {
    statStateEl.textContent = status.state;
    statStateEl.style.color = STATE_COLORS[status.state] ?? "";
  }
  const statReasonEl = document.getElementById("statReason");
  if (statReasonEl && !status.joinBackoffActive) statReasonEl.textContent = status.reason;

  // Active class card
  const statClassEl = document.getElementById("statClass");
  const statClassTimeEl = document.getElementById("statClassTime");
  if (statClassEl) {
    statClassEl.textContent = status.activeSlot ? status.activeSlot.className : "None";
  }
  if (statClassTimeEl && !status.activeSlot) statClassTimeEl.textContent = "";

  // Participants card
  const statParticipantsEl = document.getElementById("statParticipants");
  const statDuplicateEl = document.getElementById("statDuplicate");
  if (statParticipantsEl) statParticipantsEl.textContent = status.participantCount;
  if (statDuplicateEl) {
    statDuplicateEl.textContent = status.duplicateConfirmed
      ? "⚠ Duplicate detected"
      : status.participantCount > 0 ? `${status.duplicateStreak} streak` : "";
  }

  // Upcoming class pill
  if (status.upcomingSlot) {
    upcomingClass.textContent = `Upcoming: ${status.upcomingSlot.className}`;
    upcomingClass.classList.add("pill");
  } else {
    upcomingClass.textContent = "Upcoming: none";
  }

  // Session stand-down pill + cancel button
  if (status.sessionStanddown) {
    sessionStanddownPill.textContent = `Standing down: ${status.sessionStanddown.className}`;
    sessionStanddownPill.style.display = "flex";
    cancelSessionStanddownBtn.classList.remove("hidden");
  } else {
    sessionStanddownPill.style.display = "none";
    cancelSessionStanddownBtn.classList.add("hidden");
  }

  // Standdown buttons: swap active state
  document.getElementById("standdownOnBtn").disabled = status.standdown;
  document.getElementById("standdownOffBtn").disabled = !status.standdown;

  renderCountdown();
}

// ── Status fetch ───────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const status = await request("/status", { method: "GET", headers: {} });
    unlockUi();
    renderStatus(status);
  } catch {
    // handled in request
  }
}

// ── SSE with exponential backoff reconnect ─────────────────────────────────

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/events");
  eventSource.addEventListener("status", (event) => {
    try {
      const status = JSON.parse(event.data);
      unlockUi();
      renderStatus(status);
      // reset reconnect delay on successful message
      sseReconnectDelay = 3000;
    } catch {
      // ignore malformed event payload
    }
  });

  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    setTimeout(connectEvents, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
  };
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

async function sendHeartbeat() {
  if (document.visibilityState !== "visible") return;

  const deviceId = localStorage.getItem("admiral_device_id") || crypto.randomUUID();
  localStorage.setItem("admiral_device_id", deviceId);

  try {
    await request("/heartbeat", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId })
    });
  } catch {
    // ignore heartbeat errors — they're non-fatal
  }
}

function startHeartbeatLoop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, 15000);
  void sendHeartbeat();
}

function startCountdownLoop() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(renderCountdown, 1000);
}

// ── Override actions ───────────────────────────────────────────────────────

async function applyOverride(action, btn) {
  if (btn) setButtonBusy(btn, true);
  try {
    await request("/override", {
      method: "POST",
      body: JSON.stringify({ action })
    });
    errorBanner.style.display = "none";
  } catch (err) {
    showError(`Action failed: ${err.message}`);
  } finally {
    if (btn) setButtonBusy(btn, false);
  }
}

// ── History ────────────────────────────────────────────────────────────────

const HISTORY_PAGE_SIZE = 50;

const HISTORY_KIND_LABELS = {
  join_success: "Joined",
  join_failure: "Join failed",
  join_backoff_start: "Backoff",
  leave_success: "Left room",
  leave_failed: "Leave failed",
  override: "Override",
  email_suppressed: "Email muted",
  session_standdown_cleared: "Stand-down cleared",
  recovered_after_restart: "Recovered"
};

function formatHistoryTime(tsMs) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(tsMs));
}

function historyDetailText(event) {
  const parts = [];
  if (event.className) parts.push(event.className);
  const p = event.payload;
  if (p) {
    if (p.action) parts.push(`action: ${p.action}`);
    if (p.rejected) parts.push(`rejected: ${p.rejected}`);
    if (p.trigger) parts.push(String(p.trigger));
    if (p.error) parts.push(String(p.error));
    if (p.reason) parts.push(String(p.reason));
    if (p.note) parts.push(String(p.note));
    if (p.dryRun) parts.push("(dry run)");
  }
  return parts.join(" — ");
}

function renderHistoryEvents(events, append) {
  if (!append) historyList.innerHTML = "";
  if (events.length === 0 && !append) {
    historyList.innerHTML = '<div class="history-empty">No events yet.</div>';
    return;
  }
  for (const event of events) {
    const row = document.createElement("div");
    row.className = "history-row";
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatHistoryTime(event.tsMs);
    const kind = document.createElement("span");
    kind.className = "history-kind";
    kind.textContent = HISTORY_KIND_LABELS[event.kind] ?? event.kind;
    const detail = document.createElement("span");
    detail.className = "history-detail";
    detail.textContent = historyDetailText(event);
    row.append(time, kind, detail);
    historyList.appendChild(row);
  }
}

async function loadHistory(append = false) {
  try {
    const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
    if (append && historyOldestId != null) params.set("before", String(historyOldestId));
    const data = await request(`/history?${params.toString()}`, { method: "GET", headers: {} });
    const events = data.events ?? [];
    if (!append) historyOldestId = null;
    if (events.length > 0) {
      historyOldestId = events[events.length - 1].id;
      renderHistoryEvents(events, append);
    } else if (!append) {
      renderHistoryEvents([], false);
    }
    historyMoreBtn.classList.toggle("hidden", events.length < HISTORY_PAGE_SIZE);
  } catch {
    // handled in request (401 locks the UI)
  }
}

function startHistoryLoop() {
  if (historyTimer) clearInterval(historyTimer);
  historyTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !appCard.classList.contains("hidden")) {
      void loadHistory();
    }
  }, 60000);
}

historyMoreBtn.addEventListener("click", () => void loadHistory(true));

// ── Login ──────────────────────────────────────────────────────────────────

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;

  const btn = document.getElementById("loginBtn");
  setButtonBusy(btn, true);
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    });

    if (res.ok) {
      tokenInput.value = "";
      await refreshStatus();
      connectEvents();
      startHeartbeatLoop();
      startCountdownLoop();
      void loadHistory();
      startHistoryLoop();
    } else if (res.status === 429) {
      showError("Too many login attempts. Please wait a few minutes.");
    } else {
      showError("Invalid access token.");
    }
  } catch (err) {
    showError(`Login failed: ${err.message}`);
  } finally {
    setButtonBusy(btn, false);
  }
});

// ── Button handlers ────────────────────────────────────────────────────────

document.getElementById("joinBtn").addEventListener("click", (e) =>
  void applyOverride("force_join", e.currentTarget)
);

document.getElementById("leaveBtn").addEventListener("click", (e) => {
  if (!confirm("Force Admiral to leave the current room?")) return;
  void applyOverride("force_leave", e.currentTarget);
});

document.getElementById("standdownOnBtn").addEventListener("click", (e) => {
  if (!confirm("Enable global standdown? Admiral will not auto-join any classes until you turn it off.")) return;
  void applyOverride("standdown_on", e.currentTarget);
});

document.getElementById("standdownOffBtn").addEventListener("click", (e) =>
  void applyOverride("standdown_off", e.currentTarget)
);

document.getElementById("standdownSessionBtn").addEventListener("click", (e) => {
  const sessionName = lastStatus?.activeSlot?.className ?? lastStatus?.upcomingSlot?.className ?? "the next session";
  if (!confirm(`Stand down for "${sessionName}" only? Admiral will auto-resume from the following session.`)) return;
  void applyOverride("standdown_session", e.currentTarget);
});

document.getElementById("cancelSessionStanddownBtn").addEventListener("click", (e) =>
  void applyOverride("standdown_session_cancel", e.currentTarget)
);

document.getElementById("openJoinBtn").addEventListener("click", () => {
  if (lastStatus?.bbbJoinUrl) {
    window.open(lastStatus.bbbJoinUrl, "_blank", "noopener,noreferrer");
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await fetch("/logout", { method: "POST" });
  } catch {
    // best-effort
  }
  lockUi();
});

// ── Visibility change ──────────────────────────────────────────────────────

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void sendHeartbeat();
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

void refreshStatus();
connectEvents();
startHeartbeatLoop();
startCountdownLoop();
void loadHistory();
startHistoryLoop();
