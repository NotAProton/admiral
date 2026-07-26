let lastStatus = null;
let eventSource = null;
let heartbeatTimer = null;

const statusPre = document.getElementById("statusPre");
const hbState = document.getElementById("hbState");
const loginCard = document.getElementById("loginCard");
const appCard = document.getElementById("appCard");
const tokenInput = document.getElementById("tokenInput");
const siteTime = document.getElementById("siteTime");
const upcomingClass = document.getElementById("upcomingClass");
const schedulePre = document.getElementById("schedulePre");

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
    throw new Error(`${path} failed with ${res.status}`);
  }

  return res.json();
}

function lockUi() {
  loginCard.classList.remove("hidden");
  appCard.classList.add("hidden");
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function unlockUi() {
  loginCard.classList.add("hidden");
  appCard.classList.remove("hidden");
}

function renderStatus(status) {
  lastStatus = status;
  statusPre.textContent = JSON.stringify(status, null, 2);
  schedulePre.textContent = JSON.stringify(status.schedule, null, 2);

  const age = status.lastHeartbeatAgeSeconds;
  const fresh = status.heartbeatFresh;
  hbState.textContent = age == null ? "Heartbeat: none yet" : `Heartbeat age: ${age}s`;
  hbState.className = `pill ${fresh ? "ok" : "warn"}`;

  siteTime.textContent = `IST time: ${status.currentIstTime}`;

  if (status.upcomingSlot) {
    upcomingClass.textContent = `Upcoming: ${status.upcomingSlot.className} at ${status.upcomingSlot.startedAt}`;
  } else {
    upcomingClass.textContent = "Upcoming: none";
  }
}

async function refreshStatus() {
  try {
    const status = await request("/status", { method: "GET", headers: {} });
    unlockUi();
    renderStatus(status);
  } catch {
    // handled in request
  }
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/events");
  eventSource.addEventListener("status", (event) => {
    try {
      const status = JSON.parse(event.data);
      unlockUi();
      renderStatus(status);
    } catch {
      // ignore malformed event payload
    }
  });

  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    setTimeout(connectEvents, 3000);
  };
}

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
    // ignore heartbeat errors
  }
}

function startHeartbeatLoop() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, 15000);
  void sendHeartbeat();
}

async function applyOverride(action) {
  await request("/override", {
    method: "POST",
    body: JSON.stringify({ action })
  });
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) return;

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
  }
});

document.getElementById("joinBtn").addEventListener("click", () => void applyOverride("force_join"));
document.getElementById("leaveBtn").addEventListener("click", () => void applyOverride("force_leave"));
document.getElementById("standdownOnBtn").addEventListener("click", () => void applyOverride("standdown_on"));
document.getElementById("standdownOffBtn").addEventListener("click", () => void applyOverride("standdown_off"));

document.getElementById("openJoinBtn").addEventListener("click", () => {
  if (lastStatus?.bbbJoinUrl) {
    window.open(lastStatus.bbbJoinUrl, "_blank", "noopener,noreferrer");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void sendHeartbeat();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

void refreshStatus();
connectEvents();
startHeartbeatLoop();
