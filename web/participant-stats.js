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

const SVG_NS = "http://www.w3.org/2000/svg";
// Sampling runs every ~5 min while InRoom; a larger gap means Admiral was Out.
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

function mk(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  (parent ?? chart).appendChild(el);
  return el;
}

function renderChart(fromMs, toMs) {
  chart.innerHTML = "";
  const W = 960, H = 260, L = 44, R = 16, T = 14, B = 34;
  const plotW = W - L - R;
  const plotH = H - T - B;

  if (samples.length === 0) {
    const t = mk("text", { x: W / 2, y: H / 2, "text-anchor": "middle", "font-size": 13, fill: "#000000", opacity: 0.6 });
    t.textContent = "No samples for this window — Admiral only samples while it is in a room.";
    return;
  }

  const maxCount = Math.max(...samples.map((s) => s.participantCount));
  const yMax = Math.max(minParticipants + 2, maxCount + 2);
  const x = (ts) => L + ((ts - fromMs) / (toMs - fromMs)) * plotW;
  const y = (c) => T + plotH - (c / yMax) * plotH;

  // Axes
  mk("line", { x1: L, y1: T, x2: L, y2: T + plotH, stroke: "#000000", "stroke-width": 1 });
  mk("line", { x1: L, y1: T + plotH, x2: L + plotW, y2: T + plotH, stroke: "#000000", "stroke-width": 1 });

  // Hour gridlines + labels (IST)
  for (let h = 0; h <= 24; h += 2) {
    const px = x(fromMs + h * 3600_000);
    mk("line", { x1: px, y1: T + plotH, x2: px, y2: T + plotH + 4, stroke: "#000000", "stroke-width": 1 });
    if (h % 4 === 0 && h < 24) {
      const label = mk("text", { x: px, y: T + plotH + 18, "text-anchor": "middle", "font-size": 10, fill: "#000000", opacity: 0.6 });
      label.textContent = `${String(h).padStart(2, "0")}:00`;
    }
  }

  // Y ticks
  const yStep = Math.max(1, Math.ceil(yMax / 5));
  for (let c = 0; c <= yMax; c += yStep) {
    const py = y(c);
    mk("line", { x1: L - 4, y1: py, x2: L, y2: py, stroke: "#000000", "stroke-width": 1 });
    const label = mk("text", { x: L - 8, y: py + 3, "text-anchor": "end", "font-size": 10, fill: "#000000", opacity: 0.6 });
    label.textContent = String(c);
  }

  // Empty-threshold dashed line
  mk("line", { x1: L, y1: y(minParticipants), x2: L + plotW, y2: y(minParticipants), stroke: "#1c1c84", "stroke-width": 1.5, "stroke-dasharray": "6 4" });
  const thLabel = mk("text", { x: L + plotW - 4, y: y(minParticipants) - 5, "text-anchor": "end", "font-size": 10, fill: "#1c1c84" });
  thLabel.textContent = `empty < ${minParticipants}`;

  // Segments: break on Out-gaps or a room change (e.g. a sweep adoption)
  const segments = [];
  let seg = null;
  for (const s of samples) {
    if (!seg || s.tsMs - seg.last.tsMs > GAP_BREAK_MS || s.slotKey !== seg.last.slotKey) {
      seg = { key: s.slotKey, className: s.className, adopted: s.adopted, points: [], last: s };
      segments.push(seg);
    }
    seg.points.push(s);
    seg.last = s;
  }

  for (const sg of segments) {
    let d = "";
    sg.points.forEach((s, i) => {
      const px = x(s.tsMs);
      const py = y(s.participantCount);
      if (i === 0) {
        d = `M ${px} ${py}`;
      } else {
        const prev = sg.points[i - 1];
        d += ` L ${px} ${y(prev.participantCount)} L ${px} ${py}`;
      }
    });
    mk("path", { d, fill: "none", stroke: "#000000", "stroke-width": sg.adopted ? 2.5 : 1.5 });

    const first = sg.points[0];
    const segLabel = mk("text", { x: x(first.tsMs) + 2, y: T + 10, "font-size": 10, fill: "#1c1c84", opacity: 0.9 });
    segLabel.textContent = `${sg.className ?? sg.key ?? ""}${sg.adopted ? " (adopted)" : ""}`;

    for (const s of sg.points) {
      const below = s.participantCount < minParticipants;
      const c = mk("circle", {
        cx: x(s.tsMs),
        cy: y(s.participantCount),
        r: below ? 4 : 2.5,
        fill: below ? "#1c1c84" : "#000000"
      });
      if (s.adopted) {
        mk("circle", { cx: x(s.tsMs), cy: y(s.participantCount), r: 6.5, fill: "none", stroke: "#1c1c84", "stroke-width": 1 });
      }
      const title = mk("title", {}, c);
      title.textContent = `${istTime(s.tsMs)} IST — ${s.participantCount} people — ${s.className ?? s.courseId}${s.adopted ? " (adopted)" : ""}`;
    }
  }
}

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

