const form = document.getElementById("settingsForm");
const statusText = document.getElementById("statusText");
const runBadge = document.getElementById("runBadge");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const fetchBtn = document.getElementById("fetchBtn");
const diagnoseBtn = document.getElementById("diagnoseBtn");
const claimBtn = document.getElementById("claimBtn");
const copyLogsBtn = document.getElementById("copyLogsBtn");
const clearLogsBtn = document.getElementById("clearLogsBtn");
const logsEl = document.getElementById("logs");
const errorText = document.getElementById("errorText");

const MODE_PRESETS = {
  secret: { label: "机密", mode: "2", roomCode: "TFP6314" },
  topsecret: { label: "绝密", mode: "4", roomCode: "mdf6300" }
};

let currentState = null;
let saveInFlight = false;
let saveTimerId = null;

document.addEventListener("DOMContentLoaded", async () => {
  await refresh();
  window.setInterval(refresh, 1000);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.runtime || changes.settings || changes.logs)) {
    refresh();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
});

form.addEventListener("input", handleConfigChange);
form.addEventListener("change", handleConfigChange);

startBtn.addEventListener("click", async () => {
  await saveSettings({ silent: true });
  await send("start");
  await refresh();
});

stopBtn.addEventListener("click", async () => {
  await send("stop");
  await refresh();
});

fetchBtn.addEventListener("click", async () => {
  await saveSettings({ silent: true });
  await send("pollOnce");
  await refresh();
});

diagnoseBtn.addEventListener("click", async () => {
  await saveSettings({ silent: true });
  await send("diagnose");
  await refresh();
});

claimBtn.addEventListener("click", async () => {
  const device = currentState?.runtime?.matchedDevice;
  if (!device) {
    return;
  }
  claimBtn.disabled = true;
  await saveSettings({ silent: true });
  await send("claimDevice", { device });
  await refresh();
});

copyLogsBtn.addEventListener("click", async () => {
  const logs = currentState?.logs || [];
  const text = logs
    .map((log) => `[${log.at || "-"}] ${log.level || "info"} ${log.message || ""}`)
    .join("\n");
  await navigator.clipboard.writeText(text || "暂无日志");
  copyLogsBtn.textContent = "✓";
  window.setTimeout(() => {
    copyLogsBtn.textContent = "⧉";
  }, 900);
});

clearLogsBtn.addEventListener("click", async () => {
  await send("clearLogs");
  await refresh();
});

async function refresh() {
  const response = await send("getState");
  currentState = response;
  render(response);
}

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function handleConfigChange(event) {
  if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) {
    return;
  }
  if (event.target.id === "mode") {
    return;
  }
  if (event.target.id === "modePreset") {
    applyModePreset(event.target.value);
  }
  scheduleAutoSave();
}

function scheduleAutoSave() {
  if (saveTimerId) {
    window.clearTimeout(saveTimerId);
  }
  saveTimerId = window.setTimeout(async () => {
    saveTimerId = null;
    await saveSettings({ silent: true });
    await refresh();
  }, 180);
}

async function saveSettings({ silent }) {
  if (saveTimerId) {
    window.clearTimeout(saveTimerId);
    saveTimerId = null;
  }
  if (saveInFlight) {
    return;
  }
  saveInFlight = true;
  try {
    await send("saveSettings", { settings: readForm(), silent });
  } finally {
    saveInFlight = false;
  }
}

function readForm() {
  return {
    roomCode: document.getElementById("roomCode").value,
    mode: document.getElementById("mode").value,
    modePreset: document.getElementById("modePreset").value,
    pollIntervalSeconds: document.getElementById("pollIntervalSeconds").value,
    autoSubmit: document.getElementById("autoSubmit").checked
  };
}

function render(state) {
  const settings = state.settings || {};
  const runtime = state.runtime || {};
  const logs = state.logs || [];
  const modePreset = resolveModePreset(settings);

  setValue("roomCode", settings.roomCode);
  setValue("mode", settings.mode);
  setValue("modePreset", modePreset);
  setValue("pollIntervalSeconds", settings.pollIntervalSeconds);
  setChecked("autoSubmit", settings.autoSubmit);

  statusText.textContent = runtime.lastStatus || "未启动";
  errorText.textContent = runtime.lastError || "";

  runBadge.className = "badge";
  if (runtime.running) {
    runBadge.textContent = "ON";
    runBadge.classList.add("on");
  } else if (runtime.matchedDevice) {
    runBadge.textContent = "HIT";
    runBadge.classList.add("hit");
  } else {
    runBadge.textContent = "OFF";
  }

  claimBtn.disabled = !runtime.matchedDevice;
  renderLogs(logs);
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (document.activeElement !== element) {
    element.value = value ?? "";
  }
}

function applyModePreset(value) {
  const preset = MODE_PRESETS[value] || MODE_PRESETS.secret;
  document.getElementById("mode").value = preset.mode;
  document.getElementById("roomCode").value = preset.roomCode;
}

function resolveModePreset(settings) {
  if (settings.modePreset && MODE_PRESETS[settings.modePreset]) {
    return settings.modePreset;
  }
  const matched = Object.entries(MODE_PRESETS).find(([, preset]) => {
    return preset.mode === String(settings.mode || "") && preset.roomCode.toLowerCase() === String(settings.roomCode || "").toLowerCase();
  });
  return matched ? matched[0] : "secret";
}

function setChecked(id, value) {
  const element = document.getElementById(id);
  if (document.activeElement !== element) {
    element.checked = Boolean(value);
  }
}

function renderLogs(logs) {
  if (!logs.length) {
    logsEl.className = "logs empty";
    logsEl.textContent = "暂无日志";
    return;
  }

  logsEl.className = "logs";
  logsEl.textContent = "";
  for (const log of logs.slice(0, 20)) {
    const item = document.createElement("div");
    item.className = `log ${log.level || ""}`;
    const title = document.createElement("strong");
    title.textContent = formatTime(log.at);
    const message = document.createElement("span");
    message.textContent = log.message;
    item.append(title, message);
    logsEl.append(item);
  }
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
