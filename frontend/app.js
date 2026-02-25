// Version History
// v1.0 - PWA app shell, local IndexedDB logs, check-in modal, and local summary calculation.

const TIMEZONE = "Asia/Kuala_Lumpur";
const BASE_PATH = new URL("./", window.location.href).pathname;
const APP_VERSION = "20260225-7";
const PROD_BACKEND_BASE = "https://api.syaqirshaq.online/api";

const DEFAULT_BACKEND_BASE = (() => {
  const host = window.location.hostname;
  const isProdDomain =
    host === "syaqirshaq.online" ||
    host === "www.syaqirshaq.online" ||
    (host.endsWith(".syaqirshaq.online") && host !== "api.syaqirshaq.online");

  if (host.endsWith("github.io") || isProdDomain) {
    return PROD_BACKEND_BASE;
  }
  if (window.location.port === "8000") {
    return window.location.origin;
  }
  return `${window.location.origin}/api`;
})();

const BACKEND_BASE = (localStorage.getItem("fastingPwaBackendBase") || DEFAULT_BACKEND_BASE).replace(/\/$/, "");
const API = {
  config: `${BACKEND_BASE}/config`,
  subscribe: `${BACKEND_BASE}/subscribe`,
  checkin: `${BACKEND_BASE}/checkin`,
  ramadanWindow: `${BACKEND_BASE}/ramadan-window`,
  prayerTimes: `${BACKEND_BASE}/prayer-times`,
};
const DEFAULT_PRAYER_FIELDS = [
  { key: "imsak", label: "Imsak" },
  { key: "fajr", label: "Fajr" },
  { key: "sunrise", label: "Sunrise" },
  { key: "dhuhr", label: "Dhuhr" },
  { key: "asr", label: "Asr" },
  { key: "sunset", label: "Sunset" },
  { key: "maghrib", label: "Maghrib" },
  { key: "isha", label: "Isha" },
  { key: "midnight", label: "Midnight" },
];

const DB_NAME = "fasting-pwa-db";
const DB_VERSION = 1;
let dbPromise = null;
let vapidPublicKey = null;
let subscriptionEndpoint = null;
let backendConfigError = null;
let prayerTimesPayload = null;
let ramadanWindowPayload = null;
let prayerViewMode = "today";
let pendingCheckinRequest = null;
let isSubmittingCheckin = false;

const els = {
  status: document.getElementById("status"),
  logs: document.getElementById("logs"),
  checkinDialog: document.getElementById("checkinDialog"),
  checkinPrompt: document.getElementById("checkinPrompt"),
  checkinMessage: document.getElementById("checkinMessage"),
  enablePushBtn: document.getElementById("enablePushBtn"),
  openSummaryBtn: document.getElementById("openSummaryBtn"),
  ramadanDayMeta: document.getElementById("ramadanDayMeta"),
  prayerMeta: document.getElementById("prayerMeta"),
  prayerTodayTab: document.getElementById("prayerTodayTab"),
  prayer30Tab: document.getElementById("prayer30Tab"),
  prayerTodayView: document.getElementById("prayerTodayView"),
  prayer30View: document.getElementById("prayer30View"),
  prayerTableHeadRow: document.getElementById("prayerTableHeadRow"),
  prayerTableBody: document.getElementById("prayerTableBody"),
  prayerFooter: document.getElementById("prayerFooter"),
  summaryPanel: document.getElementById("summaryPanel"),
  summaryText: document.getElementById("summaryText"),
};

els.enablePushBtn.addEventListener("click", enablePush);
els.openSummaryBtn.addEventListener("click", () => {
  window.location.href = `${BASE_PATH}?view=summary`;
});
if (els.prayerTodayTab) {
  els.prayerTodayTab.addEventListener("click", () => setPrayerViewMode("today"));
}
if (els.prayer30Tab) {
  els.prayer30Tab.addEventListener("click", () => setPrayerViewMode("days30"));
}
window.addEventListener("focus", syncPushButtonState);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    syncPushButtonState();
  }
});

for (const btn of els.checkinDialog.querySelectorAll("button[data-answer]")) {
  btn.addEventListener("click", async () => {
    await answerCheckin(btn.dataset.answer);
  });
}
els.checkinDialog.addEventListener("cancel", (event) => {
  if (pendingCheckinRequest && pendingCheckinRequest.allowCancel === false) {
    event.preventDefault();
  }
});

boot();

async function boot() {
  try {
    await getDb();
    await loadSavedMeta();
    await registerServiceWorker();
    await loadBackendConfig();
    syncPushButtonState();
    await renderLogs();
    await renderRamadanDayMeta();
    await renderPrayerTimes();
    await renderRoute();
    if (backendConfigError) {
      setStatus(`Ready with limited push setup: ${backendConfigError.message}`);
    } else {
      setStatus(`Ready. Backend: ${BACKEND_BASE}`);
    }
  } catch (error) {
    console.error(error);
    setStatus(`Error: ${error.message}`);
  }
}

function setStatus(text) {
  els.status.textContent = `Status: ${text}`;
}

function currentRoute() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "checkin" || view === "summary") {
    return view;
  }

  const path = window.location.pathname;
  if (path.endsWith("/checkin")) {
    return "checkin";
  }
  if (path.endsWith("/summary")) {
    return "summary";
  }
  return "home";
}

async function renderRoute() {
  const route = currentRoute();

  if (route === "checkin") {
    const date = normalizeIsoDate(new URLSearchParams(window.location.search).get("date")) || todayInTimezone();
    pendingCheckinRequest = {
      date,
      allowCancel: true,
      redirectToHome: true,
      resolve: null,
    };
    els.checkinPrompt.textContent = `Adakah anda berpuasa pada ${formatDateLong(date)}?`;
    els.checkinMessage.textContent = "Pilih salah satu jawapan untuk simpan log harian anda.";
    if (!els.checkinDialog.open) {
      els.checkinDialog.showModal();
    }
  }

  if (route === "summary") {
    els.summaryPanel.style.display = "block";
    await renderSummary();
  }
}

async function loadBackendConfig() {
  try {
    const response = await fetch(API.config);
    if (!response.ok) {
      throw new Error(`Cannot load backend config (${response.status}).`);
    }
    const data = await response.json();
    vapidPublicKey = data.vapidPublicKey;
    backendConfigError = null;
  } catch (error) {
    backendConfigError = error;
    vapidPublicKey = null;
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker is not supported in this browser.");
  }

  const swUrl = `${BASE_PATH}sw.js?v=${APP_VERSION}`;
  await navigator.serviceWorker.register(swUrl, { scope: BASE_PATH });
}

async function enablePush() {
  const supportError = getPushSupportError();
  if (supportError) {
    setStatus(supportError);
    return;
  }

  try {
    if (!vapidPublicKey) {
      throw new Error("Backend config missing VAPID key. Check API /config and CORS.");
    }

    setStatus("Requesting notification permission...");
    const permission = await Notification.requestPermission();
    if (permission === "default") {
      setStatus("Permission prompt was dismissed. Tap Enable Push again and choose Allow.");
      syncPushButtonState();
      return;
    }

    if (permission === "denied") {
      setStatus("Notifications are blocked. Open browser site settings and set Notifications to Allow.");
      syncPushButtonState();
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ToUint8Array(vapidPublicKey),
      }));

    subscriptionEndpoint = subscription.endpoint;
    await setMeta("subscriptionEndpoint", subscriptionEndpoint);

    const response = await fetch(API.subscribe, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Subscribe failed (${response.status}).`);
    }

    setStatus("Push enabled and subscription saved. Checking missing Ramadan logs...");
    const completedCount = await runRamadanCatchupCheckins();
    if (completedCount > 0) {
      setStatus(`Push enabled. ${completedCount} missing Ramadan log(s) confirmed.`);
    } else {
      setStatus("Push enabled and subscription saved.");
    }
    syncPushButtonState();
  } catch (error) {
    console.error(error);
    setStatus(`Enable Push failed: ${error.message}`);
  }
}

async function answerCheckin(answer) {
  if (isSubmittingCheckin) return;
  isSubmittingCheckin = true;

  const activeRequest = pendingCheckinRequest;
  const routeDate = normalizeIsoDate(new URLSearchParams(window.location.search).get("date"));
  const date = activeRequest?.date || routeDate || todayInTimezone();
  const msg =
    answer === "fasting"
      ? "Alhamdulillah, semoga istiqamah."
      : "Terima kasih. Catat dan rancang ganti sebelum Ramadan seterusnya.";

  try {
    await putLog({
      date,
      status: answer,
      updatedAt: new Date().toISOString(),
    });

    els.checkinMessage.textContent = msg;
    await renderLogs();

    if (subscriptionEndpoint) {
      await fetch(API.checkin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subscriptionEndpoint,
          date,
          status: answer,
        }),
      });
    }

    const shouldRedirect = activeRequest?.redirectToHome === true;
    if (typeof activeRequest?.resolve === "function") {
      activeRequest.resolve({ date, answer });
    }
    pendingCheckinRequest = null;

    if (shouldRedirect) {
      setTimeout(() => {
        if (els.checkinDialog.open) {
          els.checkinDialog.close();
        }
        window.location.href = `${BASE_PATH}`;
      }, 500);
      return;
    }

    if (els.checkinDialog.open) {
      els.checkinDialog.close();
    }
  } catch (error) {
    console.error(error);
    setStatus(`Unable to save check-in: ${error.message}`);
  } finally {
    isSubmittingCheckin = false;
  }
}

async function runRamadanCatchupCheckins() {
  const missingDates = await getMissingRamadanLogDates();
  if (!missingDates.length) {
    return 0;
  }

  for (let i = 0; i < missingDates.length; i += 1) {
    const date = missingDates[i];
    // Keep this explicit so user can confirm each missed day one-by-one.
    await promptCheckinForDate(date, i + 1, missingDates.length);
  }

  return missingDates.length;
}

async function getMissingRamadanLogDates() {
  const windowData = await getRamadanWindow();
  const today = todayInTimezone();

  if (!windowData || today < windowData.start_date) {
    return [];
  }

  const includeToday = shouldIncludeTodayInCatchup();
  let catchupEnd = includeToday ? today : shiftIsoDate(today, -1);

  if (catchupEnd > windowData.end_date) {
    catchupEnd = windowData.end_date;
  }
  if (catchupEnd < windowData.start_date) {
    return [];
  }

  const logs = await getAllLogs();
  const loggedDates = new Set(logs.map((item) => item.date));
  const allExpectedDates = dateRange(windowData.start_date, catchupEnd);
  return allExpectedDates.filter((date) => !loggedDates.has(date));
}

function promptCheckinForDate(date, order, total) {
  return new Promise((resolve) => {
    pendingCheckinRequest = {
      date,
      allowCancel: false,
      redirectToHome: false,
      resolve,
    };

    els.checkinPrompt.textContent = `Adakah anda berpuasa pada ${formatDateLong(date)}?`;
    els.checkinMessage.textContent = `Lengkapkan rekod Ramadan tertinggal (${order}/${total}).`;

    if (!els.checkinDialog.open) {
      els.checkinDialog.showModal();
    }
  });
}

function shouldIncludeTodayInCatchup() {
  const today = todayInTimezone();
  const todayPrayer =
    prayerTimesPayload?.items?.find((item) => normalizeIsoDate(item.date) === today) || null;
  const maghrib = todayPrayer?.maghrib;
  if (!maghrib || typeof maghrib !== "string") {
    return false;
  }

  const parts = maghrib.split(":");
  const maghribHour = Number(parts[0]);
  const maghribMinute = Number(parts[1]);
  if (!Number.isFinite(maghribHour) || !Number.isFinite(maghribMinute)) {
    return false;
  }

  const nowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());

  const currentHour = Number(nowParts.find((part) => part.type === "hour")?.value);
  const currentMinute = Number(nowParts.find((part) => part.type === "minute")?.value);
  if (!Number.isFinite(currentHour) || !Number.isFinite(currentMinute)) {
    return false;
  }

  const nowTotal = currentHour * 60 + currentMinute;
  const maghribTotal = maghribHour * 60 + maghribMinute;
  return nowTotal >= maghribTotal;
}

async function renderLogs() {
  const logs = await getAllLogs();
  logs.sort((a, b) => b.date.localeCompare(a.date));

  els.logs.innerHTML = "";
  if (!logs.length) {
    const li = document.createElement("li");
    li.textContent = "No logs yet.";
    li.className = "muted";
    els.logs.appendChild(li);
    return;
  }

  for (const row of logs) {
    const li = document.createElement("li");
    li.textContent = `${row.date} - ${row.status === "fasting" ? "Puasa" : "Tidak Puasa"}`;
    els.logs.appendChild(li);
  }
}

async function renderRamadanDayMeta() {
  if (!els.ramadanDayMeta) return;

  try {
    const windowData = await getRamadanWindow();
    const today = todayInTimezone();
    const start = windowData.start_date;
    const end = windowData.end_date;

    if (today >= start && today <= end) {
      const dayNumber = dateRange(start, today).length;
      els.ramadanDayMeta.textContent = `Today is Day ${dayNumber} of Ramadan.`;
      return;
    }

    if (today < start) {
      els.ramadanDayMeta.textContent = `Ramadan has not started yet. Start date: ${formatDateLong(start)}.`;
      return;
    }

    els.ramadanDayMeta.textContent = `Ramadan has ended. End date: ${formatDateLong(end)}.`;
  } catch (error) {
    console.error(error);
    els.ramadanDayMeta.textContent = "Unable to load Ramadan day info.";
  }
}

async function getRamadanWindow() {
  if (ramadanWindowPayload) {
    return ramadanWindowPayload;
  }
  ramadanWindowPayload = await fetchJson(API.ramadanWindow);
  return ramadanWindowPayload;
}

async function renderPrayerTimes() {
  if (!els.prayerMeta) return;

  try {
    const data = await fetchJson(`${API.prayerTimes}?days=30`);
    prayerTimesPayload = data;

    const todayLabel = formatDateLong(data.today);
    els.prayerMeta.textContent = `${data.location} - ${todayLabel}`;
    els.prayerFooter.textContent = `Based on: ${data.source_name}. GMT+08:00${
      data.stale ? " - showing cached data while source refresh failed." : ""
    }`;
    setPrayerViewMode(prayerViewMode);
  } catch (error) {
    console.error(error);
    els.prayerMeta.textContent = `Unable to load prayer times: ${error.message}`;
    if (els.prayerFooter) {
      els.prayerFooter.textContent = "";
    }
  }
}

function setPrayerViewMode(mode) {
  prayerViewMode = mode;
  if (!els.prayerTodayTab || !els.prayer30Tab || !els.prayerTodayView || !els.prayer30View) {
    return;
  }

  const showToday = prayerViewMode === "today";
  els.prayerTodayTab.classList.toggle("active", showToday);
  els.prayer30Tab.classList.toggle("active", !showToday);
  els.prayerTodayView.style.display = showToday ? "grid" : "none";
  els.prayer30View.style.display = showToday ? "none" : "block";

  if (prayerTimesPayload) {
    renderPrayerToday(prayerTimesPayload);
    renderPrayerTable(prayerTimesPayload);
  }
}

function renderPrayerToday(payload) {
  const todayRow =
    payload.items.find((item) => item.date === payload.today) ||
    payload.items.find((item) => item.date >= payload.today) ||
    payload.items[0];

  if (!todayRow) {
    els.prayerTodayView.innerHTML = `<p class="muted">No prayer time data.</p>`;
    return;
  }

  const prayers = getPrayerFields(payload);

  els.prayerTodayView.innerHTML = prayers
    .map(
      (item) => `
        <article class="prayer-item">
          <h3>${item.label}</h3>
          <p>${formatTimeDisplay(todayRow[item.key])}</p>
        </article>
      `
    )
    .join("");
}

function renderPrayerTable(payload) {
  if (!els.prayerTableBody) return;
  const prayers = getPrayerFields(payload);
  const todayIso = normalizeIsoDate(payload.today) || todayInTimezone();
  if (els.prayerTableHeadRow) {
    els.prayerTableHeadRow.innerHTML = [
      "<th>Date</th>",
      ...prayers.map((item) => `<th>${item.label}</th>`),
    ].join("");
  }

  els.prayerTableBody.innerHTML = payload.items
    .map((item) => {
      const isToday = normalizeIsoDate(item.date) === todayIso;
      const cells = prayers.map((prayer) => `<td>${formatTimeDisplay(item[prayer.key])}</td>`).join("");
      return `<tr class="${isToday ? "prayer-row-today" : ""}">
        <td>${formatDateShort(item.date)}</td>
        ${cells}
      </tr>`;
    })
    .join("");
}

async function renderSummary() {
  try {
    const [windowData, logs] = await Promise.all([getRamadanWindow(), getAllLogs()]);

    const start = windowData.start_date;
    const end = windowData.end_date;
    const allDates = dateRange(start, end);

    const byDate = new Map(logs.map((item) => [item.date, item.status]));

    let fastingDays = 0;
    let nonFastingDays = 0;
    let noEntry = 0;

    for (const d of allDates) {
      const status = byDate.get(d);
      if (status === "fasting") fastingDays += 1;
      else if (status === "not_fasting") nonFastingDays += 1;
      else noEntry += 1;
    }

    const gantiNeeded = allDates.length - fastingDays;

    els.summaryText.textContent = [
      `Ramadan window: ${start} to ${end}.`,
      `Total days: ${allDates.length}.`,
      `Puasa penuh: ${fastingDays} hari.`,
      `Tidak puasa: ${nonFastingDays} hari.`,
      `Tiada log: ${noEntry} hari.`,
      `Cadangan ganti: ${gantiNeeded} hari sebelum Ramadan seterusnya.`,
      windowData.stale ? "Nota: Data Ramadan menggunakan cache lama sementara backend gagal refresh." : "",
    ]
      .filter(Boolean)
      .join(" ");
  } catch (error) {
    els.summaryText.textContent = `Unable to compute summary: ${error.message}`;
  }
}

function dateRange(startIso, endIso) {
  const out = [];
  const start = new Date(`${startIso}T12:00:00Z`);
  const end = new Date(`${endIso}T12:00:00Z`);

  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(toIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function toIsoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate, dayDelta) {
  const base = new Date(`${isoDate}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dayDelta);
  return toIsoDate(base);
}

function todayInTimezone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDateLong(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
}

function formatDateShort(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "short",
  }).format(d);
}

function getPrayerFields(payload) {
  if (!payload || !Array.isArray(payload.prayer_fields)) {
    return DEFAULT_PRAYER_FIELDS;
  }

  const normalized = payload.prayer_fields
    .filter((item) => item && typeof item === "object" && typeof item.key === "string")
    .map((item) => ({
      key: item.key,
      label: typeof item.label === "string" && item.label.trim() ? item.label : capitalizePrayerLabel(item.key),
    }));

  return normalized.length ? normalized : DEFAULT_PRAYER_FIELDS;
}

function formatTimeDisplay(value) {
  if (!value || typeof value !== "string") return "--";
  const parts = value.split(":");
  if (parts.length < 2) return value;

  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return value;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function capitalizePrayerLabel(key) {
  if (!key || typeof key !== "string") return "";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function normalizeIsoDate(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().slice(0, 10);
}

function base64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function fetchJson(url) {
  return fetch(url).then((res) => {
    if (!res.ok) {
      throw new Error(`${url} -> ${res.status}`);
    }
    return res.json();
  });
}

function getDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("logs")) {
        db.createObjectStore("logs", { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function dbRun(storeName, mode, worker) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = worker(store);

    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || request?.error);
  });
}

async function putLog(log) {
  await dbRun("logs", "readwrite", (store) => store.put(log));
}

async function getAllLogs() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("logs", "readonly");
    const store = tx.objectStore("logs");
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function setMeta(key, value) {
  await dbRun("meta", "readwrite", (store) => store.put({ key, value }));
}

async function getMeta(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

async function loadSavedMeta() {
  subscriptionEndpoint = await getMeta("subscriptionEndpoint");
}

function syncPushButtonState() {
  const supportError = getPushSupportError();
  const canEnable = !supportError && !!vapidPublicKey;
  els.enablePushBtn.disabled = !canEnable;
  if (supportError) {
    els.enablePushBtn.title = supportError;
  } else if (!vapidPublicKey) {
    els.enablePushBtn.title = "Missing backend VAPID config.";
  } else {
    els.enablePushBtn.title = "";
  }
}

function getPushSupportError() {
  if (!window.isSecureContext) {
    return "Push requires HTTPS (or localhost).";
  }

  if (!("Notification" in window) || !("PushManager" in window)) {
    return "Push is not supported in this browser.";
  }

  if (isIosBrowser() && !isStandaloneDisplayMode()) {
    return "On iPhone/iPad, install this app to Home Screen to enable push.";
  }

  if (Notification.permission === "denied") {
    return "Notifications are blocked. Open browser site settings and set Notifications to Allow.";
  }

  return null;
}

function isIosBrowser() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandaloneDisplayMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
