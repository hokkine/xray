const BASE_URL = "http://xx.78sjz.com";
const LIST_URL = `${BASE_URL}/ezweb/action?userWorkshopAction=1001`;
const CLAIM_URL = `${BASE_URL}/ezweb/action?userWorkshopAction=1002`;
const REFERER_URL = `${BASE_URL}/ezweb/wd/User/index.jsp?id=1019`;
const ALARM_NAME = "workshop-poll";
const FAST_TIMER_MAX_SECONDS = 29;

const DEFAULT_SETTINGS = {
  roomCode: "TFP6314",
  mode: "2",
  modePreset: "secret",
  captchaAction: "user1001",
  pollIntervalSeconds: 30,
  preferredDevices: "",
  autoSubmit: false
};

const MODE_LABELS = {
  secret: "机密",
  topsecret: "绝密"
};

let pollInFlight = false;
let pollTimerId = null;

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
    await schedulePolling();
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
        await schedulePolling();
        if (!message.silent) {
          await appendLog("info", "配置已保存");
        }
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
      } else if (message.type === "diagnose") {
        await diagnoseFetch();
        sendResponse({ ok: true, state: await readState() });
      } else if (message.type === "syncSessionCookie") {
        await syncSessionCookie(message.sessionId);
        sendResponse({ ok: true, state: await readState() });
      } else if (message.type === "clearLogs") {
        await chrome.storage.local.set({ logs: [] });
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
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) }),
    runtime: data.runtime || {},
    logs: data.logs || []
  };
}

function sanitizeSettings(input = {}) {
  const interval = Number.parseInt(input.pollIntervalSeconds, 10);
  return {
    roomCode: String(input.roomCode || DEFAULT_SETTINGS.roomCode).trim(),
    mode: String(input.mode || DEFAULT_SETTINGS.mode).trim(),
    modePreset: String(input.modePreset || DEFAULT_SETTINGS.modePreset).trim(),
    captchaAction: DEFAULT_SETTINGS.captchaAction,
    pollIntervalSeconds: Number.isFinite(interval) ? Math.max(1, Math.min(interval, 3600)) : 30,
    preferredDevices: "",
    autoSubmit: Boolean(input.autoSubmit)
  };
}

async function startPolling() {
  await clearPollingSchedule();
  await patchRuntime({
    running: true,
    lastStatus: "监控中",
    lastError: "",
    matchedDevice: null
  });
  await appendLog("info", "开始监控");
  await pollOnce({ allowSubmit: true });
}

async function stopPolling(status = "已停止") {
  await clearPollingSchedule();
  await patchRuntime({ running: false, lastStatus: status });
  await appendLog("info", status);
  await updateBadge();
}

async function clearPollingSchedule() {
  if (pollTimerId) {
    clearTimeout(pollTimerId);
    pollTimerId = null;
  }
  await chrome.alarms.clear(ALARM_NAME);
}

async function schedulePolling() {
  const { settings, runtime } = await readState();
  await clearPollingSchedule();
  if (!runtime?.running) {
    return;
  }
  const intervalSeconds = normalizePollInterval(settings.pollIntervalSeconds);
  if (intervalSeconds <= FAST_TIMER_MAX_SECONDS) {
    pollTimerId = setTimeout(() => {
      pollTimerId = null;
      pollOnce({ allowSubmit: true });
    }, intervalSeconds * 1000);
    return;
  }

  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalSeconds / 60 });
}

function normalizePollInterval(value) {
  const interval = Number.parseInt(value, 10);
  return Number.isFinite(interval) ? Math.max(1, Math.min(interval, 3600)) : DEFAULT_SETTINGS.pollIntervalSeconds;
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
    const idleDevices = devices.filter(isIdleDevice);
    const lockedIdleCount = idleDevices.filter(isLockedDevice).length;
    const availableDevices = idleDevices.filter(isAvailableDevice).map(normalizeDevice).sort(sortDevice);
    const matchedDevice = pickDevice(availableDevices, settings.preferredDevices);
    const status = matchedDevice
      ? `发现可提交空闲：${matchedDevice.title}`
      : `未发现可提交空闲机（空闲 ${idleDevices.length} 台，锁定 ${lockedIdleCount} 台）`;

    await patchRuntime({
      lastStatus: status,
      lastDevices: availableDevices,
      matchedDevice: matchedDevice || null,
      lastError: ""
    });
    await appendLog("info", `拉取完成，空闲 ${idleDevices.length} 台，可提交 ${availableDevices.length} 台，锁定 ${lockedIdleCount} 台`);

    if (!matchedDevice) {
      await updateBadge();
      return;
    }

    const claimContext = formatClaimContext(settings);
    await notify("发现空闲设备", `${matchedDevice.title} · ${claimContext} · ${settings.autoSubmit ? "准备自动上机" : "等待手动确认"}`);

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
    if (allowSubmit) {
      await schedulePolling();
    }
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

  return parseJsonResponse(text, "列表接口");
}

async function diagnoseFetch() {
  await patchRuntime({
    lastStatus: "诊断中",
    lastError: "",
    lastCheckedAt: new Date().toISOString()
  });
  await appendLog("info", "开始诊断列表接口");

  const cookieInfo = await getSessionCookieInfo();
  if (!cookieInfo.found) {
    throw new Error("诊断失败：未检测到 JSESSIONID，请先在网页登录");
  }
  await appendLog("info", `Cookie 已检测到：${cookieInfo.summary}`);

  const startedAt = Date.now();
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
  const contentType = response.headers.get("content-type") || "-";
  const elapsedMs = Date.now() - startedAt;
  const snippet = text.replace(/\s+/g, " ").slice(0, 220);

  await appendLog("info", `列表接口 HTTP ${response.status}，${elapsedMs}ms，${contentType}`);
  if (!response.ok) {
    throw new Error(`诊断失败：列表接口 HTTP ${response.status}。响应片段：${snippet || "空响应"}`);
  }

  const payload = parseJsonResponse(text, "诊断列表接口");
  const devices = Array.isArray(payload.Data) ? payload.Data : [];
  const idleDevices = devices.filter(isIdleDevice);
  const availableDevices = idleDevices.filter(isAvailableDevice).map(normalizeDevice).sort(sortDevice);
  const idleCount = idleDevices.length;
  const lockedIdleCount = idleDevices.filter(isLockedDevice).length;
  await patchRuntime({
    lastStatus: `诊断通过：设备 ${devices.length} 台，空闲 ${idleCount} 台，锁定 ${lockedIdleCount} 台`,
    lastDevices: availableDevices,
    matchedDevice: null,
    lastError: ""
  });
  await appendLog("info", `诊断通过：Success=${payload.Success || "-"}，设备 ${devices.length} 台，空闲 ${idleCount} 台，可提交 ${availableDevices.length} 台，锁定 ${lockedIdleCount} 台`);
}

function isIdleDevice(device) {
  const status = String(device?.kdqzt || device?.status || "").trim();
  return status.includes("空闲");
}

function isAvailableDevice(device) {
  return isIdleDevice(device) && !isLockedDevice(device);
}

function isLockedDevice(device) {
  const reservationStatus = String(device?.reservationStatus || "").trim().toUpperCase();
  const reservationAccount = String(device?.reservationAccount || "").trim();
  const reservationLockSeconds = Number.parseInt(device?.reservationLockSeconds, 10);
  const reservationLockExpireTime = String(device?.reservationLockExpireTime || "").trim();

  return (
    reservationStatus === "LOCKED" ||
    reservationAccount !== "" ||
    (Number.isFinite(reservationLockSeconds) && reservationLockSeconds > 0) ||
    reservationLockExpireTime !== ""
  );
}

function normalizeDevice(device) {
  return {
    id: String(device.ID || device.deviceId || "").trim(),
    title: String(device.deviceTitle || device.title || device.ID || "未知设备").trim(),
    status: String(device.kdqzt || "").trim(),
    customer: String(device.Customer || "").trim(),
    orderType: String(device.ordertype || "").trim(),
    power: String(device.hfb || "").trim(),
    locked: isLockedDevice(device),
    reservationStatus: String(device.reservationStatus || "").trim(),
    reservationAccount: String(device.reservationAccount || "").trim(),
    reservationLockSeconds: String(device.reservationLockSeconds || "").trim(),
    reservationLockExpireTime: String(device.reservationLockExpireTime || "").trim(),
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
  const claimContext = formatClaimContext(settings);
  if (!target?.id) {
    throw new Error("没有可提交的设备");
  }
  if (target.locked || isLockedDevice(target.raw || target)) {
    throw new Error(`设备已锁定，禁止提交：${target.title || target.id}`);
  }
  if (!settings.roomCode) {
    throw new Error("roomCode 不能为空");
  }

  await patchRuntime({ lastStatus: `提交中：${target.title} · ${claimContext}`, lastError: "" });
  await appendLog(source === "auto" ? "warn" : "info", `提交上机：${target.title} · ${claimContext}`);
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
    lastStatus: `已提交：${target.title} · ${claimContext}`,
    lastSubmittedAt: new Date().toISOString(),
    lastSubmitResponse: compactText,
    matchedDevice: target
  });
  await chrome.alarms.clear(ALARM_NAME);
  await appendLog("info", `提交完成：${target.title} · ${claimContext} · ${compactText || "空响应"}`);
  await notify("已提交上机", `${target.title} · ${claimContext} · 监控已停止`);
  await updateBadge();
}

function formatClaimContext(settings) {
  const label = MODE_LABELS[settings.modePreset] || `模式${settings.mode || "-"}`;
  return `${label} · mode=${settings.mode || "-"} · roomCode=${settings.roomCode || "-"}`;
}

async function ensureSessionCookie() {
  const cookieInfo = await getSessionCookieInfo();
  if (cookieInfo.found) {
    return;
  }

  throw new Error("未检测到 JSESSIONID，请先在网页登录");
}

async function getSessionCookieInfo() {
  const cookie = await chrome.cookies.get({ url: REFERER_URL, name: "JSESSIONID" });
  if (cookie?.value) {
    return {
      found: true,
      summary: `path=${cookie.path || "-"} domain=${cookie.domain || "-"} secure=${Boolean(cookie.secure)}`
    };
  }

  const urlCookies = await chrome.cookies.getAll({ url: REFERER_URL, name: "JSESSIONID" });
  if (urlCookies.length) {
    const summary = summarizeCookies(urlCookies);
    return { found: true, summary };
  }

  const cookies = await chrome.cookies.getAll({ domain: "xx.78sjz.com", name: "JSESSIONID" });
  if (cookies.length) {
    const summary = summarizeCookies(cookies);
    return { found: true, summary };
  }

  return { found: false, summary: "未找到" };
}

async function syncSessionCookie(sessionId) {
  const value = normalizeSessionId(sessionId);
  if (!value) {
    throw new Error("JSESSIONID 不能为空");
  }

  await chrome.cookies.set({
    url: BASE_URL,
    name: "JSESSIONID",
    value,
    path: "/ezweb"
  });
  await appendLog("info", `已写入 JSESSIONID：${maskSessionId(value)}`);
}

function normalizeSessionId(sessionId) {
  return String(sessionId || "")
    .trim()
    .replace(/^JSESSIONID\s*=\s*/i, "")
    .replace(/;.*/, "")
    .trim();
}

function summarizeCookies(cookies) {
  return cookies
    .map((item) => `path=${item.path || "-"} domain=${item.domain || "-"} secure=${Boolean(item.secure)} store=${item.storeId || "-"}`)
    .join(" | ");
}

function maskSessionId(value) {
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseJsonResponse(text, label) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    const snippet = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`${label}未返回 JSON，可能登录已失效。响应片段：${snippet || "空响应"}`);
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
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(`[上机助手] ${item.at} ${level}: ${message}`);
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
