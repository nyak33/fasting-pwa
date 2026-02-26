// Version History
// v1.0 - PWA app shell, local IndexedDB logs, check-in modal, and local summary calculation.
// v1.1 - Google login account auth for push/check-in sync.

const TIMEZONE = "Asia/Kuala_Lumpur";
const BASE_PATH = new URL("./", window.location.href).pathname;
const APP_VERSION = "20260226-10";
const PROD_BACKEND_BASE = "https://api.syaqirshaq.online/api";

const DEFAULT_BACKEND_BASE = (() => {
  const host = window.location.hostname;
  const isLocalHost = host === "127.0.0.1" || host === "localhost";
  const isProdDomain =
    host === "syaqirshaq.online" ||
    host === "www.syaqirshaq.online" ||
    (host.endsWith(".syaqirshaq.online") && host !== "api.syaqirshaq.online");

  if (host.endsWith("github.io") || isProdDomain) {
    return PROD_BACKEND_BASE;
  }
  if (isLocalHost) {
    return "http://127.0.0.1:8000";
  }
  if (window.location.port === "8000") {
    return window.location.origin;
  }
  return `${window.location.origin}/api`;
})();

const BACKEND_BASE = (localStorage.getItem("fastingPwaBackendBase") || DEFAULT_BACKEND_BASE).replace(/\/$/, "");
const API = {
  config: `${BACKEND_BASE}/config`,
  authGoogle: `${BACKEND_BASE}/auth/google`,
  authLogout: `${BACKEND_BASE}/auth/logout`,
  me: `${BACKEND_BASE}/me`,
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
let googleClientId = null;
let subscriptionEndpoint = null;
let sessionToken = null;
let currentUser = null;
let backendConfigError = null;
let prayerTimesPayload = null;
let ramadanWindowPayload = null;
let prayerViewMode = "today";
let pendingCheckinRequest = null;
let isSubmittingCheckin = false;
let googleSignInRenderStarted = false;
let currentLocationLabel = null;
let locationPermissionAsked = false;

const els = {
  status: document.getElementById("status"),
  logs: document.getElementById("logs"),
  checkinDialog: document.getElementById("checkinDialog"),
  checkinPrompt: document.getElementById("checkinPrompt"),
  checkinMessage: document.getElementById("checkinMessage"),
  authMeta: document.getElementById("authMeta"),
  googleSignIn: document.getElementById("googleSignIn"),
  logoutBtn: document.getElementById("logoutBtn"),
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
els.logoutBtn.addEventListener("click", logout);
els.openSummaryBtn.addEventListener("click", () => {
  window.location.href = `${BASE_PATH}?view=summary`;
});
if (els.prayerTodayTab) {
  els.prayerTodayTab.addEventListener("click", () => setPrayerViewMode("today"));
}
if (els.prayer30Tab) {
  els.prayer30Tab.addEventListener("click", () => setPrayerViewMode("days30"));
}
if (els.summaryText) {
  els.summaryText.addEventListener("click", handleSummaryActionClick);
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
    await initLocationPermissionAndRefresh();
    await restoreSession();
    renderAuthState();
    initGoogleSignIn();
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
    els.checkinPrompt.textContent = `Did you fast on ${formatDateLong(date)}?`;
    els.checkinMessage.textContent = "Choose one answer to save your daily log.";
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
    googleClientId = data.googleClientId || null;
    backendConfigError = null;
  } catch (error) {
    backendConfigError = error;
    vapidPublicKey = null;
    googleClientId = null;
  }
}

async function initLocationPermissionAndRefresh() {
  if (!("geolocation" in navigator)) {
    return;
  }

  const permissionState = await getGeolocationPermissionState();

  if (!locationPermissionAsked && permissionState !== "denied") {
    setStatus("Requesting location permission...");
    try {
      await refreshCurrentLocation();
    } finally {
      locationPermissionAsked = true;
      await setMeta("locationPermissionAsked", true);
    }
    return;
  }

  if (permissionState === "granted") {
    await refreshCurrentLocation();
  }
}

async function getGeolocationPermissionState() {
  if (!navigator.permissions?.query) {
    return "unknown";
  }

  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state;
  } catch (error) {
    return "unknown";
  }
}

async function refreshCurrentLocation() {
  const pos = await getCurrentPosition();
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;

  const label = await reverseGeocodeLabel(lat, lon);
  if (!label) {
    return;
  }

  currentLocationLabel = label;
  await setMeta("currentLocationLabel", currentLocationLabel);

  if (prayerTimesPayload) {
    renderPrayerMetaLine(prayerTimesPayload);
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => reject(error),
      {
        enableHighAccuracy: false,
        timeout: 12000,
        maximumAge: 0,
      }
    );
  });
}

async function reverseGeocodeLabel(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(
      lat
    )}&longitude=${encodeURIComponent(lon)}&localityLanguage=en`;
    const data = await fetchJson(url);
    const locality = data.city || data.locality || data.localityInfo?.informative?.[0]?.name || "";
    const region = data.principalSubdivision || "";
    const country = data.countryName || "";
    const label = [locality, region, country].filter(Boolean).join(", ");
    if (label) {
      return label;
    }
  } catch (error) {
    // Keep fallback below when reverse-geocode API is unavailable.
  }

  return `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`;
}

function prayerLocationLabel(payload) {
  return currentLocationLabel || payload.location || "Current location";
}

function renderPrayerMetaLine(payload) {
  const todayLabel = formatDateLong(payload.today);
  els.prayerMeta.textContent = `${prayerLocationLabel(payload)} - ${todayLabel}`;
}

function renderAuthState() {
  if (!els.authMeta || !els.googleSignIn || !els.logoutBtn) {
    return;
  }

  if (currentUser?.email) {
    const name = currentUser.name || currentUser.email;
    els.authMeta.textContent = `Signed in as ${name}.`;
    els.googleSignIn.style.display = "none";
    els.logoutBtn.style.display = "inline-block";
    return;
  }

  els.authMeta.textContent = "Google login required for push check-in sync.";
  els.googleSignIn.style.display = "block";
  els.logoutBtn.style.display = "none";
}

function initGoogleSignIn() {
  if (!googleClientId || currentUser?.email || googleSignInRenderStarted) {
    return;
  }

  const render = () => {
    if (!window.google?.accounts?.id || !els.googleSignIn) {
      setTimeout(render, 250);
      return;
    }

    googleSignInRenderStarted = true;
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: async (response) => {
        try {
          await loginWithGoogleCredential(response?.credential || "");
          renderAuthState();
          syncPushButtonState();
          setStatus("Google login successful. You can enable push now.");
        } catch (error) {
          setStatus(`Google login failed: ${error.message}`);
        }
      },
    });

    els.googleSignIn.innerHTML = "";
    window.google.accounts.id.renderButton(els.googleSignIn, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
      width: 240,
    });
  };

  render();
}

async function loginWithGoogleCredential(credential) {
  if (!credential) {
    throw new Error("Missing Google credential.");
  }

  const response = await fetch(API.authGoogle, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) {
    throw new Error(`Auth failed (${response.status}).`);
  }

  const data = await response.json();
  sessionToken = data.sessionToken;
  currentUser = data.user || null;
  await setMeta("sessionToken", sessionToken);
  await setMeta("currentUser", currentUser);
}

async function restoreSession() {
  if (!sessionToken) {
    currentUser = null;
    return;
  }

  try {
    const response = await fetch(API.me, { headers: authHeaders() });
    if (!response.ok) {
      throw new Error(`Session check failed (${response.status})`);
    }
    const data = await response.json();
    currentUser = data.user || null;
    await setMeta("currentUser", currentUser);
  } catch (error) {
    sessionToken = null;
    currentUser = null;
    await setMeta("sessionToken", null);
    await setMeta("currentUser", null);
  }
}

async function logout() {
  try {
    if (sessionToken) {
      await fetch(API.authLogout, { method: "POST", headers: authHeaders() });
    }
  } finally {
    sessionToken = null;
    currentUser = null;
    googleSignInRenderStarted = false;
    await setMeta("sessionToken", null);
    await setMeta("currentUser", null);
    renderAuthState();
    initGoogleSignIn();
    syncPushButtonState();
    setStatus("Logged out.");
  }
}

function authHeaders(extra = {}) {
  if (!sessionToken) {
    return { ...extra };
  }
  return { Authorization: `Bearer ${sessionToken}`, ...extra };
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
    if (!sessionToken) {
      throw new Error("Login with Google first.");
    }
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
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        subscription: subscription.toJSON(),
      }),
    });

    if (response.status === 401) {
      await logout();
      throw new Error("Session expired. Please login again.");
    }
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
      ? "Recorded: fasting."
      : "Recorded: missed / not fasting.";

  try {
    await putLog({
      date,
      status: answer,
      updatedAt: new Date().toISOString(),
    });

    els.checkinMessage.textContent = msg;
    await renderLogs();

    if (!sessionToken) {
      throw new Error("Login with Google first so your check-in syncs across devices.");
    }

    const syncResponse = await fetch(API.checkin, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        date,
        status: answer,
      }),
    });

    if (syncResponse.status === 401) {
      await logout();
      throw new Error("Session expired. Please login again.");
    }
    if (!syncResponse.ok) {
      throw new Error(`Check-in sync failed (${syncResponse.status}).`);
    }

    if (currentRoute() === "summary") {
      await renderSummary();
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

    els.checkinPrompt.textContent = `Did you fast on ${formatDateLong(date)}?`;
    els.checkinMessage.textContent = `Complete missing Ramadan logs (${order}/${total}).`;

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
    li.textContent = `${row.date} - ${row.status === "fasting" ? "Fasting" : "Missed / Not fasting"}`;
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
    renderPrayerMetaLine(data);
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

function formatSummaryDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function summaryStatusLine(dataStatus) {
  if (dataStatus === "fresh") {
    return "✅ Data is up to date";
  }
  if (dataStatus === "cached") {
    return "🟡 Showing cached data (refresh failed). Try again later.";
  }
  return "🔴 Data unavailable. Please try again.";
}

function renderSummaryMarkup({
  startDate,
  endDate,
  totalDays,
  completedFasts,
  missedFasts,
  noLogs,
  dataStatus,
}) {
  const subheader = `${formatSummaryDate(startDate)} – ${formatSummaryDate(endDate)} • ${totalDays} days`;
  const showActions = noLogs > 0;
  const makeUpLine =
    missedFasts > 0
      ? `Make-up fasts needed: <strong>${missedFasts}</strong>`
      : "Make-up fasts needed: 0 (based on logs)";

  els.summaryText.innerHTML = `
    <div class="summary-layout">
      <header class="summary-header">
        <h2>Ramadan Summary</h2>
        <p class="muted summary-subheader">${subheader}</p>
      </header>

      <section class="summary-section">
        <h3>Progress (based on logs)</h3>
        <div class="summary-stats">
          <article class="summary-stat">
            <span class="summary-stat-label">Completed (logged)</span>
            <span class="summary-stat-value">${completedFasts}</span>
          </article>
          <article class="summary-stat">
            <span class="summary-stat-label">Missed (logged)</span>
            <span class="summary-stat-value">${missedFasts}</span>
          </article>
          <article class="summary-stat">
            <span class="summary-stat-label">Unlogged days</span>
            <span class="summary-stat-value">${noLogs}</span>
          </article>
        </div>
        ${
          noLogs > 0
            ? `<p class="muted">Unlogged days are not counted as missed fasts. They’re simply not recorded yet.</p>`
            : ""
        }
      </section>

      <section class="summary-section">
        <h3>Make-up</h3>
        <p>${makeUpLine}</p>
      </section>

      ${
        showActions
          ? `<section class="summary-section">
               <h3>Actions</h3>
               <div class="summary-actions">
                 <button type="button" class="btn-primary" data-summary-action="log-today">Log today</button>
                 <button type="button" class="btn-outline" data-summary-action="review-unlogged">Review unlogged days</button>
               </div>
             </section>`
          : ""
      }

      <p class="summary-status">${summaryStatusLine(dataStatus)}</p>
    </div>
  `;
}

function handleSummaryActionClick(event) {
  const button = event.target.closest("button[data-summary-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.summaryAction;
  if (action === "log-today") {
    const date = todayInTimezone();
    pendingCheckinRequest = {
      date,
      allowCancel: true,
      redirectToHome: false,
      resolve: null,
    };
    els.checkinPrompt.textContent = `Did you fast on ${formatDateLong(date)}?`;
    els.checkinMessage.textContent = "Record today's fasting status.";
    if (!els.checkinDialog.open) {
      els.checkinDialog.showModal();
    }
    return;
  }

  if (action === "review-unlogged") {
    runRamadanCatchupCheckins()
      .then((count) => {
        if (!count) {
          setStatus("No unlogged days to review.");
        }
      })
      .catch((error) => {
        setStatus(`Unable to review unlogged days: ${error.message}`);
      });
  }
}

async function renderSummary() {
  try {
    const [windowData, logs] = await Promise.all([getRamadanWindow(), getAllLogs()]);

    const startDate = windowData.start_date;
    const endDate = windowData.end_date;
    const allDates = dateRange(startDate, endDate);
    const byDate = new Map(logs.map((item) => [item.date, item.status]));

    let completedFasts = 0;
    let missedFasts = 0;
    let noLogs = 0;

    for (const d of allDates) {
      const status = byDate.get(d);
      if (status === "fasting") {
        completedFasts += 1;
      } else if (status === "not_fasting") {
        missedFasts += 1;
      } else {
        noLogs += 1;
      }
    }

    renderSummaryMarkup({
      startDate,
      endDate,
      totalDays: allDates.length,
      completedFasts,
      missedFasts,
      noLogs,
      dataStatus: windowData.stale ? "cached" : "fresh",
    });
  } catch (error) {
    els.summaryText.innerHTML = `
      <div class="summary-layout">
        <header class="summary-header">
          <h2>Ramadan Summary</h2>
          <p class="muted summary-subheader">Summary unavailable</p>
        </header>
        <p class="summary-status">${summaryStatusLine("error")}</p>
      </div>
    `;
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
  sessionToken = await getMeta("sessionToken");
  currentUser = (await getMeta("currentUser")) || null;
  currentLocationLabel = (await getMeta("currentLocationLabel")) || null;
  locationPermissionAsked = (await getMeta("locationPermissionAsked")) === true;
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
  if (!sessionToken || !currentUser?.email) {
    return "Login with Google first.";
  }

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
