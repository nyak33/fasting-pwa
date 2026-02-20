// Version History
// v1.0 - PWA app shell, local IndexedDB logs, check-in modal, and local summary calculation.

const TIMEZONE = "Asia/Kuala_Lumpur";
const BASE_PATH = new URL("./", window.location.href).pathname;

const DEFAULT_BACKEND_BASE = (() => {
  if (window.location.hostname.endsWith("github.io")) {
    return "https://api.syaqirshaq.online/api";
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
};

const DB_NAME = "fasting-pwa-db";
const DB_VERSION = 1;
let dbPromise = null;
let vapidPublicKey = null;
let subscriptionEndpoint = null;

const els = {
  status: document.getElementById("status"),
  logs: document.getElementById("logs"),
  checkinDialog: document.getElementById("checkinDialog"),
  checkinPrompt: document.getElementById("checkinPrompt"),
  checkinMessage: document.getElementById("checkinMessage"),
  enablePushBtn: document.getElementById("enablePushBtn"),
  openSummaryBtn: document.getElementById("openSummaryBtn"),
  summaryPanel: document.getElementById("summaryPanel"),
  summaryText: document.getElementById("summaryText"),
};

els.enablePushBtn.addEventListener("click", enablePush);
els.openSummaryBtn.addEventListener("click", () => {
  window.location.href = `${BASE_PATH}?view=summary`;
});

for (const btn of els.checkinDialog.querySelectorAll("button[data-answer]")) {
  btn.addEventListener("click", async () => {
    await answerCheckin(btn.dataset.answer);
  });
}

boot();

async function boot() {
  try {
    await getDb();
    await loadSavedMeta();
    await loadBackendConfig();
    await registerServiceWorker();
    await renderLogs();
    await renderRoute();
    setStatus(`Ready. Backend: ${BACKEND_BASE}`);
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
    const date = new URLSearchParams(window.location.search).get("date") || todayInTimezone();
    els.checkinPrompt.textContent = `Adakah anda berpuasa pada ${date}?`;
    els.checkinMessage.textContent = "Pilih salah satu jawapan untuk simpan log harian anda.";
    els.checkinDialog.showModal();
  }

  if (route === "summary") {
    els.summaryPanel.style.display = "block";
    await renderSummary();
  }
}

async function loadBackendConfig() {
  const response = await fetch(API.config);
  if (!response.ok) {
    throw new Error(`Cannot load backend config (${response.status}).`);
  }
  const data = await response.json();
  vapidPublicKey = data.vapidPublicKey;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker is not supported in this browser.");
  }

  const swUrl = `${BASE_PATH}sw.js`;
  await navigator.serviceWorker.register(swUrl, { scope: BASE_PATH });
}

async function enablePush() {
  if (!("Notification" in window) || !("PushManager" in window)) {
    setStatus("Push is not supported in this browser.");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setStatus("Notification permission was not granted.");
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

  setStatus("Push enabled and subscription saved.");
}

async function answerCheckin(answer) {
  const date = new URLSearchParams(window.location.search).get("date") || todayInTimezone();
  const msg =
    answer === "fasting"
      ? "Alhamdulillah, semoga istiqamah."
      : "Terima kasih. Catat dan rancang ganti sebelum Ramadan seterusnya.";

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

  setTimeout(() => {
    if (els.checkinDialog.open) {
      els.checkinDialog.close();
    }
    window.location.href = `${BASE_PATH}`;
  }, 500);
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

async function renderSummary() {
  try {
    const [windowData, logs] = await Promise.all([fetchJson(API.ramadanWindow), getAllLogs()]);

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

function todayInTimezone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
