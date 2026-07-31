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
  if (lastStatus.schedule?.activeSlot) {
    const endsAt = new Date(lastStatus.schedule.activeSlot.endsAt).getTime();
    const remaining = Math.max(0, Math.round((endsAt - now) / 1000));
    if (classTimeEl) classTimeEl.textContent = `Ends in ${formatDuration(remaining)}`;
  }

  // Next class countdown
  const countdownEl = document.getElementById("statCountdown");
  const countdownClassEl = document.getElementById("statCountdownClass");
  if (lastStatus.schedule?.upcomingSlot) {
    const startsAt = new Date(lastStatus.schedule.upcomingSlot.startedAt).getTime();
    const until = Math.max(0, Math.round((startsAt - now) / 1000));
    if (countdownEl) countdownEl.textContent = formatDuration(until);
    if (countdownClassEl) countdownClassEl.textContent = lastStatus.schedule.upcomingSlot.className;
  } else {
    if (countdownEl) countdownEl.textContent = "--";
    if (countdownClassEl) countdownClassEl.textContent = "No upcoming class";
  }

  // Join backoff remaining
  if (lastStatus.suppressions?.joinBackoffActive && lastStatus.suppressions?.joinBackoffRemainingSeconds != null) {
    const statReasonEl = document.getElementById("statReason");
    if (statReasonEl && !statReasonEl.textContent.includes("backoff")) {
    }
    const remaining = Math.max(0, (lastStatus.suppressions?.joinBackoffRemainingSeconds ?? 0) - Math.round((now - new Date(lastStatus.updatedAt).getTime()) / 1000));
    const backoffEl = document.getElementById("statReason");
    if (backoffEl && lastStatus.suppressions?.joinBackoffActive) {
      backoffEl.textContent = `Backing off — resumes in ${formatDuration(remaining)}`;
    }
  }
}

// ── Status rendering ───────────────────────────────────────────────────────

const STATE_COLORS = {
  Out: "var(--st-out)",
  Joining: "var(--st-joining)",
  InRoom: "var(--st-inroom)",
  Leaving: "var(--st-leaving)"
};

const STATE_LABELS = {
  Out: "OUT",
  Joining: "JOINING",
  InRoom: "IN ROOM",
  Leaving: "LEAVING"
};

function renderStatus(status) {
  lastStatus = status;
  statusPre.textContent = JSON.stringify(status, null, 2);
  schedulePre.textContent = JSON.stringify(status.schedule?.config, null, 2);

  const age = status.heartbeat?.lastAgeSeconds;
  const fresh = status.heartbeat?.fresh;
  hbState.textContent = age == null ? "Heartbeat: none yet" : `Heartbeat: ${age}s ago`;
  hbState.className = `pill ${fresh ? "ok" : "warn"}`;

  // State summary card — stripe + colored value word + dot inherits color
  const state = status.control?.state ?? "Out";
  const stateBox = document.getElementById("stateBox");
  const statStateEl = document.getElementById("statState");
  if (stateBox && statStateEl) {
    // Swap the state-stripe modifier class on the card.
    for (const s of ["Out", "Joining", "InRoom", "Leaving"]) {
      stateBox.classList.toggle(`stat-box--${s}`, s === state);
    }
    statStateEl.textContent = STATE_LABELS[state] ?? state.toUpperCase();
  }
  // Topbar state pill — glanceable even when scrolled
  const topbarState = document.getElementById("topbarState");
  const topbarStateText = document.getElementById("topbarStateText");
  if (topbarState && topbarStateText) {
    for (const s of ["Out", "Joining", "InRoom", "Leaving"]) {
      topbarState.classList.toggle(`topbar-state--${s}`, s === state);
    }
    topbarStateText.textContent = STATE_LABELS[state] ?? state.toUpperCase();
  }
  const statReasonEl = document.getElementById("statReason");
  if (statReasonEl && !status.suppressions?.joinBackoffActive) statReasonEl.textContent = status.control?.reason ?? "";

  // Active class card
  const statClassEl = document.getElementById("statClass");
  const statClassTimeEl = document.getElementById("statClassTime");
  if (statClassEl) {
    statClassEl.textContent = status.schedule?.activeSlot ? status.schedule.activeSlot.className : "None";
  }
  if (statClassTimeEl && !status.schedule?.activeSlot) statClassTimeEl.textContent = "";

  // Participants card
  const statParticipantsEl = document.getElementById("statParticipants");
  const statDuplicateEl = document.getElementById("statDuplicate");
  if (statParticipantsEl) statParticipantsEl.textContent = status.presence?.participantCount ?? 0;
  if (statDuplicateEl) {
    const isDuplicate = status.presence?.duplicateConfirmed;
    if (isDuplicate) {
      statDuplicateEl.textContent = "⚠ Duplicate detected";
      statDuplicateEl.classList.add("danger");
    } else {
      statDuplicateEl.textContent = (status.presence?.participantCount ?? 0) > 0
        ? `${status.presence?.duplicateStreak ?? 0} streak`
        : "";
      statDuplicateEl.classList.remove("danger");
    }
  }

  // Upcoming class pill
  if (status.schedule?.upcomingSlot) {
    upcomingClass.textContent = `Upcoming: ${status.schedule.upcomingSlot.className}`;
    upcomingClass.classList.add("pill");
  } else {
    upcomingClass.textContent = "No more classes today";
  }

  // Session stand-down pill + cancel button
  if (status.suppressions?.sessionStanddown) {
    sessionStanddownPill.textContent = `Standing down: ${status.suppressions.sessionStanddown.className}`;
    sessionStanddownPill.style.display = "flex";
    cancelSessionStanddownBtn.classList.remove("hidden");
  } else {
    sessionStanddownPill.style.display = "none";
    cancelSessionStanddownBtn.classList.add("hidden");
  }

  // Standdown buttons: swap active state
  document.getElementById("standdownOnBtn").disabled = status.suppressions?.globalStanddown ?? false;
  document.getElementById("standdownOffBtn").disabled = !(status.suppressions?.globalStanddown ?? false);

  // Presence-control button enablement.
  // Risk-aware: Force Join is gated (risky action), Join Myself needs a URL,
  // Force Leave needs something to leave.
  const joinBtn = document.getElementById("joinBtn");
  const leaveBtn = document.getElementById("leaveBtn");
  const openJoinBtn = document.getElementById("openJoinBtn");
  const hasActiveSlot = status.schedule?.activeSlot != null;
  const inRoomOrJoining = state === "InRoom" || state === "Joining";
  if (joinBtn) joinBtn.disabled = !hasActiveSlot || inRoomOrJoining;
  if (leaveBtn) leaveBtn.disabled = !inRoomOrJoining;
  if (openJoinBtn) openJoinBtn.disabled = !status.presence?.bbbJoinUrl;

  // ── System strip (demoted telemetry) ─────────────────────────────────────
  const emailPill = document.getElementById("emailBudgetPill");
  if (emailPill) {
    if (status.email) {
      emailPill.textContent = `emails: ${status.email.emailsToday}/${status.email.emailDailyCap}` +
        (status.email.suppressedToday > 0 ? ` (${status.email.suppressedToday} muted)` : "");
    } else {
      emailPill.textContent = "emails: —";
    }
  }

  const scheduleSourceEl = document.getElementById("scheduleSourcePill");
  if (scheduleSourceEl) {
    const when = status.schedule?.loadedAt
      ? new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(new Date(status.schedule.loadedAt))
      : "--";
    scheduleSourceEl.textContent = `schedule: ${status.schedule?.source ?? "?"} @ ${when}`;
  }

  const workerHealthEl = document.getElementById("workerHealthPill");
  if (workerHealthEl) {
    const age = status.heartbeat?.lastAgeSeconds;
    const hbStale = age == null || age > 120;
    const backoffActive = status.suppressions?.joinBackoffActive ?? false;
    let health = "ok";
    if (hbStale) health = "heartbeat stale";
    else if (backoffActive) health = "backoff";
    workerHealthEl.textContent = `worker: ${health}`;
    workerHealthEl.style.color = health === "ok" ? "" : "var(--warn)";
  }

  // Current room pill
  const roomPill = document.getElementById("currentRoomPill");
  if (roomPill) {
    if (status.presence?.currentRoom) {
      roomPill.textContent = status.presence.currentRoom.adopted
        ? `Covering: ${status.presence.currentRoom.className} (moved from ${status.presence.currentRoom.adoptedFromClassName})`
        : `In room: ${status.presence.currentRoom.className}`;
      roomPill.style.display = "";
    } else {
      roomPill.style.display = "none";
    }
  }

  // Room watch pill
  const watchPill = document.getElementById("roomWatchPill");
  if (watchPill) {
    const rw = status.watch;
    let text = "";
    if (rw && rw.enabled) {
      if (rw.belowThresholdSince) {
        const mins = Math.max(0, Math.round((Date.now() - new Date(rw.belowThresholdSince).getTime()) / 60000));
        text = `Room looks empty (${status.presence?.participantCount ?? 0}/${rw.minParticipants}) — watching ${mins}m`;
      } else if (rw.nextSweepRetryAt) {
        const secs = Math.max(0, Math.round((new Date(rw.nextSweepRetryAt).getTime() - Date.now()) / 1000));
        text = `No populated room — rechecking in ${formatDuration(secs)}`;
      } else if (status.control?.state === "InRoom" && !rw.scrapeOk) {
        text = "Participant scrape failing";
      }
    }
    watchPill.textContent = text;
    watchPill.style.display = text ? "" : "none";
  }

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
      // Reset reconnect delay on successful message
      sseReconnectDelay = 3000;
      // Refresh history to update the ticker. Debounced: the 10s poll
      // already covers the steady-state case; this handles the "user just
      // acted and wants to see it now" cue without adding a second API call.
      scheduleHistoryRefresh();
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

let historyRefreshTimer = null;
function scheduleHistoryRefresh() {
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    if (document.visibilityState === "visible") void loadHistory();
  }, 800);
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
  email_send_failed: "Email send failed",
  session_update: "Email sent (session update)",
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
  const isNewHead = !append && events.length > 0 && events[0].id !== lastTickerEventId;
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
  // Ticker = rolling tail of the same event stream.
  if (events.length > 0) renderTicker(events[0], isNewHead);
}

let lastTickerEventId = null;
const tickerEl = document.getElementById("ticker");

function tickerTime(tsMs) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(tsMs));
}

function renderTicker(event, flash) {
  if (!tickerEl || !event) return;
  const timeEl = tickerEl.querySelector(".ticker-time");
  const kindEl = tickerEl.querySelector(".ticker-kind");
  const detailEl = tickerEl.querySelector(".ticker-detail");
  if (timeEl) timeEl.textContent = tickerTime(event.tsMs);
  if (kindEl) {
    kindEl.textContent = HISTORY_KIND_LABELS[event.kind] ?? event.kind;
    kindEl.classList.remove("ticker-empty");
  }
  if (detailEl) detailEl.textContent = historyDetailText(event);
  lastTickerEventId = event.id;
  if (flash) {
    tickerEl.classList.add("flash");
    setTimeout(() => tickerEl.classList.remove("flash"), 400);
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
  }, 10000);
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
  const sessionName = lastStatus?.schedule?.activeSlot?.className ?? lastStatus?.schedule?.upcomingSlot?.className ?? "the next session";
  if (!confirm(`Stand down for "${sessionName}" only? Admiral will auto-resume from the following session.`)) return;
  void applyOverride("standdown_session", e.currentTarget);
});

document.getElementById("cancelSessionStanddownBtn").addEventListener("click", (e) =>
  void applyOverride("standdown_session_cancel", e.currentTarget)
);

document.getElementById("openJoinBtn").addEventListener("click", () => {
  if (lastStatus?.presence?.bbbJoinUrl) {
    window.open(lastStatus.presence.bbbJoinUrl, "_blank", "noopener,noreferrer");
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
