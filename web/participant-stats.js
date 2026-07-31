// Participant stats: renders the worker's participant_samples time series.
// Data comes from GET /participant-samples (session-cookie authed, same as /status).

const dateInput = document.getElementById("dateInput");
const courseSelect = document.getElementById("courseSelect");
const reloadBtn = document.getElementById("reloadBtn");
const metaLine = document.getElementById("metaLine");
const chart = document.getElementById("chart");
const sessionCards = document.getElementById("sessionCards");
const sampleRows = document.getElementById("sampleRows");
const errorBanner = document.getElementById("errorBanner");
const loginCard = document.getElementById("loginCard");
const appCard = document.getElementById("appCard");

const GAP_BREAK_MS = 15 * 60 * 1000;

const knownCourses = new Map(); // courseId -> className (kept across course-filtered reloads)
let samples = [];
let minParticipants = 3;

function showError(message, durationMs = 6000) {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
  setTimeout(() => {
    errorBanner.style.display = "none";
  }, durationMs);
}

function lockToLogin() {
  loginCard.classList.remove("hidden");
  appCard.classList.add("hidden");
}

async function request(path) {
  const res = await fetch(path, { headers: { "content-type": "application/json" } });
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

// "en-CA" yields YYYY-MM-DD, which is what <input type="date"> wants.
function istTodayStr() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

// IST day boundaries as epoch ms (Asia/Kolkata has no DST, fixed +05:30).
function istDayRangeMs(dateStr) {
  const fromMs = Date.parse(`${dateStr}T00:00:00+05:30`);
  return { fromMs, toMs: fromMs + 24 * 60 * 60 * 1000 - 1 };
}

const istTime = (tsMs) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(tsMs));

async function load() {
  const dateStr = dateInput.value || istTodayStr();
  const { fromMs, toMs } = istDayRangeMs(dateStr);
  const params = new URLSearchParams({ from: String(fromMs), to: String(toMs), limit: "2000" });
  if (courseSelect.value) params.set("courseId", courseSelect.value);

  try {
    const data = await request(`/participant-samples?${params.toString()}`);
    samples = data.samples ?? [];
    minParticipants = data.minParticipants ?? 3;
    for (const s of samples) knownCourses.set(s.courseId, s.className ?? s.courseId);
    renderCourseOptions();
    renderAll(fromMs, toMs);
  } catch (err) {
    if (err.message !== "Unauthorized") showError(err.message);
  }
}

function renderCourseOptions() {
  const current = courseSelect.value;
  courseSelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All courses";
  courseSelect.appendChild(all);
  for (const [id, name] of [...knownCourses.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    courseSelect.appendChild(opt);
  }
  courseSelect.value = current;
}

function renderAll(fromMs, toMs) {
  metaLine.textContent =
    `${samples.length} samples · empty threshold: below ${minParticipants} people · auto-refresh 60s`;
  renderChart(fromMs, toMs);
  renderSessions();
  renderTable();
}

// ── uPlot chart ──────────────────────────────────────────────────────────

let uplotInstance = null;

function renderChart(fromMs, toMs) {
  if (uplotInstance) {
    uplotInstance.destroy();
    uplotInstance = null;
  }

  if (samples.length === 0) {
    chart.textContent = "No samples for this window — Admiral only samples while it is in a room.";
    chart.style.padding = "40px";
    chart.style.textAlign = "center";
    chart.style.opacity = "0.6";
    return;
  }
  chart.style = "";

  // Build uPlot data arrays: [ts[], count[], threshold[]]
  const ts = [];
  const counts = [];
  const threshold = [];

  // Insert NaN gaps where samples are >= GAP_BREAK_MS apart or slotKey changes
  let prev = null;
  for (const s of samples) {
    if (prev && (s.tsMs - prev.tsMs > GAP_BREAK_MS || s.slotKey !== prev.slotKey)) {
      ts.push(prev.tsMs + 1);
      counts.push(null);
      threshold.push(null);
      ts.push(s.tsMs - 1);
      counts.push(null);
      threshold.push(null);
    }
    ts.push(s.tsMs / 1000); // uPlot uses seconds
    counts.push(s.participantCount);
    threshold.push(minParticipants);
    prev = s;
  }

  const opts = {
    width: chart.clientWidth || 960,
    height: 260,
    title: "",
    cursor: { show: false },

    axes: [
      {
        // x-axis: IST time
        stroke: "#000",
        grid: { stroke: "#ddd", width: 0.5 },
        ticks: { stroke: "#000", width: 1 },
        values: [
          [3600, "{HH}:{mm}", null, null, null, null, null, null, 2],
        ],
      },
      {
        // y-axis: participant count
        stroke: "#000",
        grid: { stroke: "#ddd", width: 0.5 },
        ticks: { stroke: "#000", width: 1 },
        values: (self, ticks) => ticks.map((v) => v < 1e4 ? String(v) : ""),
      },
    ],

    series: [
      {},
      // Series 1: participant count (main line)
      {
        label: "Participants",
        stroke: "#000",
        width: 1.5,
        paths: uPlot.paths.stepped({ align: 1 }),
        points: { show: true, size: 3, stroke: "#000", fill: "#fff" },
      },
      // Series 2: empty threshold (dashed reference line)
      {
        label: "Empty threshold",
        stroke: "#1c1c84",
        width: 1.5,
        dash: [6, 4],
        paths: uPlot.paths.stepped({ align: 1 }),
        points: { show: false },
      },
    ],
  };

  const data = [ts, counts, threshold];
  uplotInstance = new uPlot(opts, data, chart);
}

// ── Session cards (unchanged) ───────────────────────────────────────────

function renderSessions() {
  if (samples.length === 0) {
    sessionCards.innerHTML = `<div class="muted">No samples in this window.</div>`;
    return;
  }
  const groups = new Map();
  for (const s of samples) {
    const key = s.slotKey ?? s.courseId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  sessionCards.innerHTML = "";
  for (const rows of groups.values()) {
    const counts = rows.map((r) => r.participantCount);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const avg = (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1);
    const belowPct = Math.round((counts.filter((c) => c < minParticipants).length / counts.length) * 100);
    const adopted = rows.some((r) => r.adopted);
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML =
      `<div class="card-title">${escapeHtml(rows[0].className ?? rows[0].courseId)}` +
      `${adopted ? `<span class="badge">adopted via sweep</span>` : ""}` +
      `${belowPct >= 50 ? `<span class="badge low">mostly empty</span>` : ""}</div>` +
      `<div>${istTime(rows[0].tsMs)} – ${istTime(rows[rows.length - 1].tsMs)} IST · ${rows.length} samples</div>` +
      `<div>min ${min} · avg ${avg} · max ${max} people · below threshold in ${belowPct}% of samples</div>`;
    sessionCards.appendChild(div);
  }
}

function renderTable() {
  if (samples.length === 0) {
    sampleRows.innerHTML = `<tr><td colspan="4" class="muted">No samples in this window.</td></tr>`;
    return;
  }
  sampleRows.innerHTML = "";
  for (const s of [...samples].reverse().slice(0, 300)) {
    const tr = document.createElement("tr");
    if (s.participantCount < minParticipants) tr.className = "low";
    tr.innerHTML =
      `<td>${istTime(s.tsMs)}</td>` +
      `<td>${escapeHtml(s.className ?? s.courseId)}</td>` +
      `<td class="num">${s.participantCount}</td>` +
      `<td>${s.adopted ? "adopted" : "scheduled"}</td>`;
    sampleRows.appendChild(tr);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

reloadBtn.addEventListener("click", () => void load());
dateInput.addEventListener("change", () => void load());
courseSelect.addEventListener("change", () => void load());

dateInput.value = istTodayStr();
void load();
setInterval(() => void load(), 60_000);

