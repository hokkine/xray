const BASE_URL = "http://xx.78sjz.com";
const LIST_URL = `${BASE_URL}/ezweb/action?userWorkshopAction=1001`;
const CLAIM_URL = `${BASE_URL}/ezweb/action?userWorkshopAction=1002`;
const REFERER_URL = `${BASE_URL}/ezweb/wd/User/index.jsp?id=1019`;
const ALARM_NAME = "workshop-poll";

const DEFAULT_SETTINGS = {
  roomCode: "TFP6314",
  mode: "2",
  captchaAction: "user1001",
  pollIntervalSeconds: 30,
  preferredDevices: "",
  autoSubmit: false
};

let pollInFlight = false;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["settings", "runtime"]);
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!stored.runtime) {
    await chrome.storage.local.set({
      runtime: {
        running: false,
        lastStatus: "未启动",
        lastDevices: [],
        matchedDevice: null,
        lastError: "",
        lastCheckedAt: "",
        lastSubmittedAt: "",
        lastSubmitResponse: ""
      },
      logs: []
    });
  }
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const { runtime } = await chrome.storage.local.get("runtime");
  if (runtime?.running) {
    await scheduleAlarm();
  }
  await updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollOnce({ allowSubmit: true });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "getState") {
        sendResponse(await readState());
      } else if (message.type === "saveSettings") {
        const settings = sanitizeSettings(message.settings);
        await chrome.storage.local.set({ settings });
        await scheduleAlarm();
        await appendLog("info", "配置已保存");
        sendResponse({ ok: true, state: await readState() });
      } else if (message.type === "start") {
        await startPolling();
        sendResponse({ ok: true, state: await readState() });
      } else if (message.type === "stop") {
        await stopPolling("已停止");
        sendResponse({ ok: true, state: await readState() });
      } else if (message.type === "pollOnce") {
        await pollOnce({ allowSubmit: false });
        sendResponse({ ok: true, state: await readState() });
      } else if (message.type === "claimDevice") {
        await claimDevice(message.device || null, { source: "manual" });
        sendResponse({ ok: true, state: await readState() });
      } else {
        sendResponse({ ok: false, error: "未知消息" });
      }
    } catch (error) {
      await appendLog("error", error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error), state: await readState() });
    }
  })();
  return true;
});

async function readState() {
  const data = await chrome.storage.local.get(["settings", "runtime", "logs"]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    runtime: data.runtime || {},
    logs: data.logs || []
  };
}

function sanitizeSettings(input = {}) {
  const interval = Number.parseInt(input.pollIntervalSeconds, 10);
  return {
    roomCode: String(input.roomCode || DEFAULT_SETTINGS.roomCode).trim(),
    mode: String(input.mode || DEFAULT_SETTINGS.mode).trim(),
    captchaAction: String(input.captchaAction || DEFAULT_SETTINGS.captchaAction).trim(),
    pollIntervalSeconds: Number.isFinite(interval) ? Math.max(30, Math.min(interval, 3600)) : 30,
    preferredDevices: String(input.preferredDevices || "").trim(),
    autoSubmit: Boolean(input.autoSubmit)
  };
}

async function startPolling() {
  await patchRuntime({
    running: true,
    lastStatus: "监控中",
    lastError: "",
    matchedDevice: null
  });
  await appendLog("info", "开始监控");
  await scheduleAlarm();
  await pollOnce({ allowSubmit: true });
}

async function stopPolling(status = "已停止") {
  await chrome.alarms.clear(ALARM_NAME);
  await patchRuntime({ running: false, lastStatus: status });
  await appendLog("info", status);
  await updateBadge();
}

async function scheduleAlarm() {
  const { settings, runtime } = await readState();
  await chrome.alarms.clear(ALARM_NAME);
  if (!runtime?.running) {
    return;
  }
  const periodInMinutes = Math.max(30, Number(settings.pollIntervalSeconds) || 30) / 60;
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes });
}

async function pollOnce({ allowSubmit }) {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    const { settings, runtime } = await readState();
    if (allowSubmit && !runtime?.running) {
      return;
    }

    await patchRuntime({
      lastStatus: "拉取中",
      lastError: "",
      lastCheckedAt: new Date().toISOString()
    });

    const payload = await fetchDeviceList();
    const devices = Array.isArray(payload.Data) ? payload.Data : [];
    const idleDevices = devices.filter(isIdleDevice).map(normalizeDevice).sort(sortDevice);
    const matchedDevice = pickDevice(idleDevices, settings.preferredDevices);
    const status = matchedDevice ? `发现空闲：${matchedDevice.title}` : `未发现匹配空闲机（空闲 ${idleDevices.length} 台）`;

    await patchRuntime({
      lastStatus: status,
      lastDevices: idleDevices,
      matchedDevice: matchedDevice || null,
      lastError: ""
    });
    await appendLog("info", `拉取完成，空闲 ${idleDevices.length} 台`);

    if (!matchedDevice) {
      await updateBadge();
      return;
    }

    await notify("发现空闲设备", `${matchedDevice.title} ${settings.autoSubmit ? "准备自动上机" : "等待手动确认"}`);

    if (allowSubmit && settings.autoSubmit) {
      await claimDevice(matchedDevice, { source: "auto" });
    } else {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    }
  } catch (error) {
    await patchRuntime({
      lastStatus: "拉取失败",
      lastError: error.message || String(error)
    });
    await appendLog("error", error.message || String(error));
    await updateBadge();
  } finally {
    pollInFlight = false;
  }
}

async function fetchDeviceList() {
  await ensureSessionCookie();
  const response = await fetch(LIST_URL, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    },
    referrer: REFERER_URL
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`列表接口失败：HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error("列表接口未返回 JSON，可能登录已失效");
  }
}

function isIdleDevice(device) {
  const status = String(device?.kdqzt || device?.status || "").trim();
  return status.includes("空闲");
}

function normalizeDevice(device) {
  return {
    id: String(device.ID || device.deviceId || "").trim(),
    title: String(device.deviceTitle || device.title || device.ID || "未知设备").trim(),
    status: String(device.kdqzt || "").trim(),
    customer: String(device.Customer || "").trim(),
    orderType: String(device.ordertype || "").trim(),
    power: String(device.hfb || "").trim(),
    raw: device
  };
}

function pickDevice(devices, preferredDevices) {
  if (!devices.length) {
    return null;
  }
  const needles = String(preferredDevices || "")
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!needles.length) {
    return devices[0];
  }

  return devices.find((device) => {
    const text = `${device.id} ${device.title} ${device.customer} ${device.orderType}`.toLowerCase();
    return needles.some((needle) => text.includes(needle.toLowerCase()));
  }) || null;
}

function sortDevice(a, b) {
  return extractNumber(a.title) - extractNumber(b.title) || a.title.localeCompare(b.title, "zh-CN");
}

function extractNumber(text) {
  const match = String(text).match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER;
}

async function claimDevice(device, { source }) {
  const { settings, runtime } = await readState();
  const target = device || runtime?.matchedDevice;
  if (!target?.id) {
    throw new Error("没有可提交的设备");
  }
  if (!settings.roomCode) {
    throw new Error("roomCode 不能为空");
  }

  await patchRuntime({ lastStatus: `提交中：${target.title}`, lastError: "" });
  await appendLog(source === "auto" ? "warn" : "info", `提交上机：${target.title}`);
  await ensureSessionCookie();

  const body = new URLSearchParams({
    deviceId: target.id,
    mode: settings.mode,
    roomCode: settings.roomCode,
    captchaAction: settings.captchaAction
  });

  const response = await fetch(CLAIM_URL, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "*/*",
      "Cache-Control": "no-cache",
      "Content-Type": "application/x-www-form-urlencoded",
      Pragma: "no-cache"
    },
    referrer: REFERER_URL,
    body
  });

  const text = await response.text();
  const compactText = text.replace(/\s+/g, " ").slice(0, 500);
  if (!response.ok) {
    throw new Error(`上机接口失败：HTTP ${response.status} ${compactText}`);
  }

  await patchRuntime({
    running: false,
    lastStatus: `已提交：${target.title}`,
    lastSubmittedAt: new Date().toISOString(),
    lastSubmitResponse: compactText,
    matchedDevice: target
  });
  await chrome.alarms.clear(ALARM_NAME);
  await appendLog("info", `提交完成：${compactText || "空响应"}`);
  await notify("已提交上机", `${target.title} 已提交，监控已停止`);
  await updateBadge();
}

async function ensureSessionCookie() {
  const cookie = await chrome.cookies.get({ url: BASE_URL, name: "JSESSIONID" });
  if (!cookie?.value) {
    throw new Error("未检测到 JSESSIONID，请先在网页登录");
  }
}

async function patchRuntime(patch) {
  const { runtime } = await chrome.storage.local.get("runtime");
  await chrome.storage.local.set({ runtime: { ...(runtime || {}), ...patch } });
  await updateBadge();
}

async function appendLog(level, message) {
  const { logs } = await chrome.storage.local.get("logs");
  const item = {
    level,
    message,
    at: new Date().toISOString()
  };
  await chrome.storage.local.set({ logs: [item, ...((logs || []).slice(0, 79))] });
}

async function updateBadge() {
  const { runtime } = await chrome.storage.local.get("runtime");
  if (runtime?.running) {
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  } else if (runtime?.matchedDevice) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon.svg",
      title,
      message
    });
  } catch (_error) {
    // Notifications can fail on some platforms when Chrome rejects SVG icons.
  }
}
