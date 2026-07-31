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
const todayList = document.getElementById("todayList");
const todaySwapHint = document.getElementById("todaySwapHint");
const todayOverrideList = document.getElementById("todayOverrideList");
const todayAddCourse = document.getElementById("todayAddCourse");
const todayAddStart = document.getElementById("todayAddStart");
const todayAddEnd = document.getElementById("todayAddEnd");
const todayAddBtn = document.getElementById("todayAddBtn");

let historyTimer = null;
let historyOldestId = null;
let swapArmedStart = null;

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

  // Email budget pill (today's sends vs the IST-day cap)
  const emailPill = document.getElementById("emailBudgetPill");
  if (emailPill && status.emailBudget) {
    emailPill.textContent = `Emails today: ${status.emailBudget.emailsToday}/${status.emailBudget.emailDailyCap}` +
      (status.emailBudget.suppressedToday > 0 ? ` · ${status.emailBudget.suppressedToday} muted` : "");
  }

  // Schedule source pill (env/file/url/cache + loaded-at time)
  const scheduleSourceEl = document.getElementById("scheduleSourcePill");
  if (scheduleSourceEl) {
    const when = status.scheduleLoadedAt
      ? new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(new Date(status.scheduleLoadedAt))
      : "--";
    scheduleSourceEl.textContent = `Schedule: ${status.scheduleSource} @ ${when}` +
      (status.scheduleUrl ? ` · ${status.scheduleUrl}` : "");
  }

  // Current room pill — adopted rooms (empty-room sweep) show where Admiral moved from
  const roomPill = document.getElementById("currentRoomPill");
  if (roomPill) {
    if (status.currentRoom) {
      roomPill.textContent = status.currentRoom.adopted
        ? `Covering: ${status.currentRoom.className} (moved from ${status.currentRoom.adoptedFromClassName})`
        : `In room: ${status.currentRoom.className}`;
      roomPill.style.display = "";
    } else {
      roomPill.style.display = "none";
    }
  }

  // Room watch pill — empty-room evaluation progress and sweep retry countdown
  const watchPill = document.getElementById("roomWatchPill");
  if (watchPill) {
    const rw = status.roomWatch;
    let text = "";
    if (rw && rw.enabled) {
      if (rw.belowThresholdSince) {
        const mins = Math.max(0, Math.round((Date.now() - new Date(rw.belowThresholdSince).getTime()) / 60000));
        text = `Room looks empty (${status.participantCount}/${rw.minParticipants}) — watching ${mins}m`;
      } else if (rw.nextSweepRetryAt) {
        const secs = Math.max(0, Math.round((new Date(rw.nextSweepRetryAt).getTime() - Date.now()) / 1000));
        text = `No populated room — rechecking in ${formatDuration(secs)}`;
      } else if (status.state === "InRoom" && !rw.scrapeOk) {
        text = "Participant scrape failing";
      }
    }
    watchPill.textContent = text;
    watchPill.style.display = text ? "" : "none";
  }

  renderTodayPanel(status);

  renderCountdown();
}

function courseNameById(status, courseId) {
  const course = status.schedule.courses.find((c) => c.courseId === courseId);
  return course ? `${course.courseId} ${course.className}` : courseId;
}

function formatOverrideLine(status, row) {
  const ops = row.ops || {};
  if (Array.isArray(ops.cancel) && ops.cancel.length > 0) {
    return `Cancelled: ${ops.cancel.map((id) => courseNameById(status, id)).join(", ")}`;
  }
  if (Array.isArray(ops.swap) && ops.swap.length > 0) {
    const s = ops.swap[0];
    return `Swapped: ${s.a} ↔ ${s.b}`;
  }
  if (Array.isArray(ops.add) && ops.add.length > 0) {
    const a = ops.add[0];
    return `Added: ${courseNameById(status, a.courseId)} ${a.start}-${a.end}`;
  }
  return "Updated schedule";
}

async function applyDayOverride(payload, btn) {
  if (btn) setButtonBusy(btn, true);
  try {
    const result = await request("/day-override", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (Array.isArray(result.issues) && result.issues.length > 0) {
      showError(result.issues.map((issue) => issue.detail).join("; "));
    }
    await refreshStatus();
  } catch (err) {
    showError(`Action failed: ${err.message}`);
  } finally {
    if (btn) setButtonBusy(btn, false);
  }
}

async function deleteDayOverride(id, btn) {
  if (btn) setButtonBusy(btn, true);
  try {
    await request("/day-override-delete", {
      method: "POST",
      body: JSON.stringify({ id })
    });
    await refreshStatus();
  } catch (err) {
    showError(`Undo failed: ${err.message}`);
  } finally {
    if (btn) setButtonBusy(btn, false);
  }
}

function renderTodayPanel(status) {
  const courses = status.schedule.courses ?? [];
  const slots = status.todaySlots ?? [];
  const overrides = status.todayOverrides ?? [];

  if (swapArmedStart && !slots.some((slot) => slot.startedAt.slice(11, 16) === swapArmedStart)) {
    swapArmedStart = null;
  }

  const selectedCourse = todayAddCourse.value;
  todayAddCourse.innerHTML = "";
  for (const course of courses) {
    const opt = document.createElement("option");
    opt.value = course.courseId;
    opt.textContent = `${course.courseId} ${course.className}`;
    todayAddCourse.appendChild(opt);
  }
  if (selectedCourse && courses.some((course) => course.courseId === selectedCourse)) {
    todayAddCourse.value = selectedCourse;
  }

  todayList.innerHTML = "";
  if (slots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "today-row";
    empty.textContent = "No classes scheduled for today.";
    todayList.appendChild(empty);
  }

  for (const slot of slots) {
    const row = document.createElement("div");
    row.className = "today-row";
    const start = slot.startedAt.slice(11, 16);
    const end = slot.endsAt.slice(11, 16);
    if (swapArmedStart === start) row.classList.add("swap-armed");

    const text = document.createElement("div");
    text.className = "today-slot";
    text.textContent = `${start}-${end}  ${slot.className}`;

    const actions = document.createElement("div");
    actions.className = "today-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      if (!confirm(`Cancel ${slot.className} today? Admiral will skip it.`)) return;
      await applyDayOverride({ op: "cancel", courseId: slot.courseId }, cancelBtn);
    });

    const swapBtn = document.createElement("button");
    swapBtn.className = "secondary";
    swapBtn.textContent = "Swap";
    swapBtn.addEventListener("click", async () => {
      if (!swapArmedStart) {
        swapArmedStart = start;
        renderTodayPanel(status);
        return;
      }
      if (swapArmedStart === start) {
        swapArmedStart = null;
        renderTodayPanel(status);
        return;
      }
      const first = swapArmedStart;
      swapArmedStart = null;
      await applyDayOverride({ op: "swap", a: first, b: start }, swapBtn);
    });

    actions.append(cancelBtn, swapBtn);
    row.append(text, actions);
    todayList.appendChild(row);
  }

  todaySwapHint.classList.toggle("hidden", !swapArmedStart);

  todayOverrideList.innerHTML = "";
  if (overrides.length === 0) {
    const empty = document.createElement("div");
    empty.className = "override-row";
    empty.textContent = "No applied overrides.";
    todayOverrideList.appendChild(empty);
  }

  for (const rowData of overrides) {
    const row = document.createElement("div");
    row.className = "override-row";

    const text = document.createElement("div");
    text.className = "today-slot";
    text.textContent = formatOverrideLine(status, rowData);

    const undoBtn = document.createElement("button");
    undoBtn.className = "secondary";
    undoBtn.textContent = "Undo";
    undoBtn.addEventListener("click", async () => {
      if (!confirm("Undo this override?")) return;
      await deleteDayOverride(rowData.id, undoBtn);
    });

    row.append(text, undoBtn);
    todayOverrideList.appendChild(row);
  }
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

todayAddBtn.addEventListener("click", async (event) => {
  const courseId = todayAddCourse.value;
  const start = todayAddStart.value;
  const end = todayAddEnd.value;
  if (!courseId || !start || !end) {
    showError("Pick course, start time, and end time.");
    return;
  }
  await applyDayOverride({ op: "add", courseId, start, end }, event.currentTarget);
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
