// "Today" page: same-day schedule overrides (cancel / swap / add).
// Standalone page mirroring /participant-stats: session cookie is shared with
// the status page. Live updates via the /events SSE stream; initial /status
// fetch fills the panel before the first push.

let lastStatus = null;
let eventSource = null;
let sseReconnectDelay = 3000;

const errorBanner = document.getElementById("errorBanner");
const loginCard = document.getElementById("loginCard");
const appCard = document.getElementById("appCard");
const todayList = document.getElementById("todayList");
const todaySwapHint = document.getElementById("todaySwapHint");
const todayOverrideList = document.getElementById("todayOverrideList");
const todayAddCourse = document.getElementById("todayAddCourse");
const todayAddStart = document.getElementById("todayAddStart");
const todayAddEnd = document.getElementById("todayAddEnd");
const todayAddBtn = document.getElementById("todayAddBtn");

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
    lockToLogin();
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

function lockToLogin() {
  loginCard.classList.remove("hidden");
  appCard.classList.add("hidden");
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function unlockApp() {
  loginCard.classList.add("hidden");
  appCard.classList.remove("hidden");
}
// ── Today panel ─────────────────────────────────────────────────────────────

function courseNameById(status, courseId) {
  const course = status.schedule?.config?.courses?.find((c) => c.courseId === courseId);
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
    if (err.message !== "Unauthorized") showError(`Action failed: ${err.message}`);
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
    if (err.message !== "Unauthorized") showError(`Undo failed: ${err.message}`);
  } finally {
    if (btn) setButtonBusy(btn, false);
  }
}
function renderTodayPanel(status) {
  const courses = status.schedule?.config?.courses ?? [];
  const slots = status.schedule?.todaySlots ?? [];
  const overrides = status.schedule?.todayOverrides ?? [];

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
function renderStatus(status) {
  lastStatus = status;
  renderTodayPanel(status);
}

// ── Status fetch ────────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const status = await request("/status", { method: "GET", headers: {} });
    unlockApp();
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
      unlockApp();
      renderStatus(status);
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

// ── Add class handler ───────────────────────────────────────────────────────

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

// ── Boot ────────────────────────────────────────────────────────────────────

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

// A backgrounded/locked phone can silently drop the SSE connection without
// ever firing onerror until the tab is foregrounded again. Force a status
// refresh and reconnect the stream if needed when the page becomes visible,
// so this panel doesn't sit on stale data (this page had no such listener
// at all, unlike the main dashboard).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshStatus();
    if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
      sseReconnectDelay = 3000;
      connectEvents();
    }
  }
});

void refreshStatus();
connectEvents();
