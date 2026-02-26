// Version History
// v1.0 - PWA app shell, local IndexedDB logs, check-in modal, and local summary calculation.
// v1.1 - Google login account auth for push/check-in sync.
// v1.2 - Calendar logging, multi-year Ramadan view, and ganti tracking.

const TIMEZONE = "Asia/Kuala_Lumpur";
const BASE_PATH = new URL("./", window.location.href).pathname;
const APP_VERSION = "20260226-16";
const PROD_BACKEND_BASE = "https://api.syaqirshaq.online/api";

const RAMADAN_YEAR_CONFIG = {
  2024: { start: "2024-03-12", end: "2024-04-09" },
  2025: { start: "2025-03-02", end: "2025-03-30" },
  2026: { start: "2026-02-18", end: "2026-03-19" },
};

const DEFAULT_BACKEND_BASE = (() => {
  const host = window.location.hostname;
  const isLocalHost = host === "127.0.0.1" || host === "localhost";
  const isProdDomain =
    host === "syaqirshaq.online" ||
    host === "www.syaqirshaq.online" ||
    (host.endsWith(".syaqirshaq.online") && host !== "api.syaqirshaq.online");

  if (host.endsWith("github.io") || isProdDomain) return PROD_BACKEND_BASE;
  if (isLocalHost) return "http://127.0.0.1:8000";
  if (window.location.port === "8000") return window.location.origin;
  return `${window.location.origin}/api`;
})();

const BACKEND_BASE = (localStorage.getItem("fastingPwaBackendBase") || DEFAULT_BACKEND_BASE).replace(/\/$/, "");
const API = {
  config: `${BACKEND_BASE}/config`,
  authGoogle: `${BACKEND_BASE}/auth/google`,
  authLogout: `${BACKEND_BASE}/auth/logout`,
  me: `${BACKEND_BASE}/me`,
  subscribe: `${BACKEND_BASE}/subscribe`,
  unsubscribe: `${BACKEND_BASE}/unsubscribe`,
  checkin: `${BACKEND_BASE}/checkin`,
  prayerTimes: `${BACKEND_BASE}/prayer-times`,
  notificationSettings: `${BACKEND_BASE}/notification-settings`,
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
];
const DEFAULT_REMINDER_SLOTS = [
  { type: "fixed", time: "09:00" },
  { type: "fixed", time: "13:30" },
  { type: "fixed", time: "18:00" },
];

const DB_NAME = "fasting-pwa-db";
const DB_VERSION = 2;
let dbPromise = null;
let vapidPublicKey = null;
let googleClientId = null;
let sessionToken = null;
let currentUser = null;
let prayerTimesPayload = null;
let prayerViewMode = "today";
let googleSignInRenderStarted = false;
let currentLocationLabel = null;
let locationPermissionAsked = false;
let isSubmittingDialogAction = false;
let hasPushSubscription = false;

const state = {
  selectedRamadanYear: null,
  viewMonthYear: null,
  viewMonthIndex: null,
  logsByDate: new Map(),
  requiredManualByYear: {},
  activeDate: null,
  activeStatus: null,
  activeTag: null,
  pendingCheckinRequest: null,
  reminderSlots: [...DEFAULT_REMINDER_SLOTS],
  reminderSlotCount: 3,
};

const els = {
  status: document.getElementById("status"),
  checkinDialog: document.getElementById("checkinDialog"),
  checkinPrompt: document.getElementById("checkinPrompt"),
  checkinMessage: document.getElementById("checkinMessage"),
  tagSection: document.getElementById("tagSection"),
  authMeta: document.getElementById("authMeta"),
  googleSignIn: document.getElementById("googleSignIn"),
  logoutBtn: document.getElementById("logoutBtn"),
  enablePushBtn: document.getElementById("enablePushBtn"),
  disablePushBtn: document.getElementById("disablePushBtn"),
  openSummaryBtn: document.getElementById("openSummaryBtn"),
  ramadanDayMeta: document.getElementById("ramadanDayMeta"),
  ramadanYearSelect: document.getElementById("ramadanYearSelect"),
  ramadanViewTitle: document.getElementById("ramadanViewTitle"),
  monthPrevBtn: document.getElementById("monthPrevBtn"),
  monthNextBtn: document.getElementById("monthNextBtn"),
  calendarMonthLabel: document.getElementById("calendarMonthLabel"),
  calendarGrid: document.getElementById("calendarGrid"),
  ramadanSummaryBody: document.getElementById("ramadanSummaryBody"),
  gantiSummaryBody: document.getElementById("gantiSummaryBody"),
  summarySection: document.getElementById("summarySection"),
  openOverrideBtn: document.getElementById("openOverrideBtn"),
  overrideDialog: document.getElementById("overrideDialog"),
  overrideYearSelect: document.getElementById("overrideYearSelect"),
  overrideRequiredInput: document.getElementById("overrideRequiredInput"),
  overrideMissedLine: document.getElementById("overrideMissedLine"),
  overrideError: document.getElementById("overrideError"),
  overrideSaveBtn: document.getElementById("overrideSaveBtn"),
  overrideCancelBtn: document.getElementById("overrideCancelBtn"),
  overrideClearBtn: document.getElementById("overrideClearBtn"),
  prayerMeta: document.getElementById("prayerMeta"),
  prayerTodayTab: document.getElementById("prayerTodayTab"),
  prayer30Tab: document.getElementById("prayer30Tab"),
  prayerTodayView: document.getElementById("prayerTodayView"),
  prayer30View: document.getElementById("prayer30View"),
  prayerTableHeadRow: document.getElementById("prayerTableHeadRow"),
  prayerTableBody: document.getElementById("prayerTableBody"),
  prayerFooter: document.getElementById("prayerFooter"),
  reminderSlots: document.getElementById("reminderSlots"),
  reminderSlotCount: document.getElementById("reminderSlotCount"),
  saveReminderSettingsBtn: document.getElementById("saveReminderSettingsBtn"),
  reminderSettingsStatus: document.getElementById("reminderSettingsStatus"),
};

setupEventListeners();
boot();

function setupEventListeners() {
  els.enablePushBtn?.addEventListener("click", enablePush);
  els.disablePushBtn?.addEventListener("click", disablePush);
  els.logoutBtn?.addEventListener("click", logout);
  els.openSummaryBtn?.addEventListener("click", () => {
    els.summarySection?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.ramadanYearSelect?.addEventListener("change", () => {
    const year = Number(els.ramadanYearSelect.value);
    if (!RAMADAN_YEAR_CONFIG[year]) return;
    setSelectedRamadanYear(year, true);
    renderAll();
    renderRamadanDayMeta();
  });

  els.monthPrevBtn?.addEventListener("click", () => {
    shiftViewMonth(-1);
    renderCalendar();
  });
  els.monthNextBtn?.addEventListener("click", () => {
    shiftViewMonth(1);
    renderCalendar();
  });

  els.calendarGrid?.addEventListener("click", (event) => {
    const dayButton = event.target.closest("button.day-cell");
    if (!dayButton) return;
    const date = normalizeIsoDate(dayButton.dataset.date || "");
    if (!date) return;
    if (date > todayInTimezone()) return;
    openDayDialog(date);
  });

  if (els.checkinDialog) {
    for (const btn of els.checkinDialog.querySelectorAll("button[data-answer]")) {
      btn.addEventListener("click", () => handleDialogAnswer(btn.dataset.answer || ""));
    }
    for (const btn of els.checkinDialog.querySelectorAll("button[data-tag]")) {
      btn.addEventListener("click", () => handleTagSelection(btn.dataset.tag || ""));
    }
    els.checkinDialog.addEventListener("cancel", (event) => {
      if (state.pendingCheckinRequest?.allowCancel === false) event.preventDefault();
    });
  }

  els.openOverrideBtn?.addEventListener("click", openOverrideDialog);
  els.overrideYearSelect?.addEventListener("change", () => syncOverrideFormForYear(Number(els.overrideYearSelect.value)));
  els.overrideSaveBtn?.addEventListener("click", saveOverride);
  els.overrideCancelBtn?.addEventListener("click", () => els.overrideDialog?.close());
  els.overrideClearBtn?.addEventListener("click", clearOverrideForFormYear);

  els.prayerTodayTab?.addEventListener("click", () => setPrayerViewMode("today"));
  els.prayer30Tab?.addEventListener("click", () => setPrayerViewMode("days30"));
  setupReminderEditorListeners();
  els.saveReminderSettingsBtn?.addEventListener("click", saveReminderSettings);

  window.addEventListener("focus", () => {
    refreshPushSubscriptionState();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshPushSubscriptionState();
  });
}

function getReminderSlotEditors() {
  if (!els.reminderSlots) return [];
  return Array.from(els.reminderSlots.querySelectorAll(".reminder-slot"));
}

function setupReminderEditorListeners() {
  els.reminderSlotCount?.addEventListener("change", () => {
    const nextCount = clampReminderSlotCount(Number(els.reminderSlotCount.value));
    setReminderSlotCount(nextCount);
    setReminderStatus(`Using ${nextCount} reminder slot(s).`);
  });
  for (const slotEl of getReminderSlotEditors()) {
    const typeSelect = slotEl.querySelector("[data-slot-type]");
    typeSelect?.addEventListener("change", () => syncReminderSlotVisibility(slotEl));
  }
}

function syncReminderSlotVisibility(slotEl) {
  const typeSelect = slotEl.querySelector("[data-slot-type]");
  const selected = String(typeSelect?.value || "fixed");
  for (const fixedWrap of slotEl.querySelectorAll("[data-fixed-wrap]")) {
    fixedWrap.style.display = selected === "fixed" ? "grid" : "none";
  }
  for (const prayerWrap of slotEl.querySelectorAll("[data-prayer-wrap]")) {
    prayerWrap.style.display = selected === "prayer" ? "grid" : "none";
  }
}

function setReminderStatus(message, isError = false) {
  if (!els.reminderSettingsStatus) return;
  els.reminderSettingsStatus.textContent = message;
  els.reminderSettingsStatus.style.color = isError ? "#b23a3a" : "";
}

function initReminderEditors() {
  setReminderSlotCount(3);
  applyReminderSlotsToEditors(DEFAULT_REMINDER_SLOTS);
  syncReminderAuthState();
}

function clampReminderSlotCount(value) {
  if (!Number.isInteger(value)) return 3;
  return Math.max(1, Math.min(3, value));
}

function setReminderSlotCount(value) {
  const count = clampReminderSlotCount(value);
  state.reminderSlotCount = count;
  if (els.reminderSlotCount) {
    els.reminderSlotCount.value = String(count);
  }

  const editors = getReminderSlotEditors();
  editors.forEach((slotEl, index) => {
    const enabled = index < count;
    slotEl.style.display = enabled ? "grid" : "none";
    for (const input of slotEl.querySelectorAll("input, select, button, textarea")) {
      input.disabled = !enabled;
    }
  });
}

function syncReminderAuthState() {
  const loggedIn = !!sessionToken && !!currentUser?.email;
  if (els.saveReminderSettingsBtn) {
    els.saveReminderSettingsBtn.disabled = !loggedIn;
  }
  if (!loggedIn) {
    setReminderStatus("Login required to save notification settings.");
  }
}

function applyReminderSlotsToEditors(slots) {
  const normalized = normalizeReminderSlots(slots);
  state.reminderSlots = normalized;
  setReminderSlotCount(normalized.length || 1);

  const editors = getReminderSlotEditors();
  editors.forEach((slotEl, index) => {
    const slot = normalized[index] || DEFAULT_REMINDER_SLOTS[index] || DEFAULT_REMINDER_SLOTS[0];
    const typeSelect = slotEl.querySelector("[data-slot-type]");
    const timeInput = slotEl.querySelector("[data-slot-time]");
    const prayerSelect = slotEl.querySelector("[data-slot-prayer]");
    const directionSelect = slotEl.querySelector("[data-slot-direction]");
    const offsetInput = slotEl.querySelector("[data-slot-offset]");
    const offset = slot.type === "prayer" ? Number(slot.offset_minutes || 0) : 0;

    if (typeSelect) typeSelect.value = slot.type;
    if (timeInput) timeInput.value = slot.type === "fixed" ? slot.time : "09:00";
    if (prayerSelect) prayerSelect.value = slot.type === "prayer" ? slot.prayer : "maghrib";
    if (directionSelect) directionSelect.value = offset < 0 ? "before" : "after";
    if (offsetInput) offsetInput.value = String(Math.abs(offset));
    syncReminderSlotVisibility(slotEl);
  });
}

function normalizeReminderSlots(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_REMINDER_SLOTS];
  const out = [];
  for (const item of raw.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").trim().toLowerCase();
    if (type === "fixed") {
      const hhmm = normalizeHhmm(item.time);
      if (!hhmm) continue;
      out.push({ type: "fixed", time: hhmm });
      continue;
    }
    if (type === "prayer") {
      const prayer = String(item.prayer || "").trim().toLowerCase();
      if (!["imsak", "fajr", "sunrise", "dhuhr", "asr", "sunset", "maghrib", "isha"].includes(prayer)) {
        continue;
      }
      let offset = Number(item.offset_minutes);
      if (!Number.isInteger(offset)) offset = 0;
      offset = Math.max(-180, Math.min(180, offset));
      out.push({ type: "prayer", prayer, offset_minutes: offset });
    }
  }
  return out.length ? out : [...DEFAULT_REMINDER_SLOTS];
}

function normalizeHhmm(value) {
  if (typeof value !== "string") return "";
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return "";
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return "";
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function collectReminderSlotsFromEditors() {
  const slots = [];
  const count = clampReminderSlotCount(state.reminderSlotCount);
  const editors = getReminderSlotEditors().slice(0, count);
  for (const slotEl of editors) {
    const type = String(slotEl.querySelector("[data-slot-type]")?.value || "fixed");
    if (type === "fixed") {
      const hhmm = normalizeHhmm(String(slotEl.querySelector("[data-slot-time]")?.value || ""));
      if (!hhmm) {
        setReminderStatus("Please set a valid HH:MM time for all manual slots.", true);
        return null;
      }
      slots.push({ type: "fixed", time: hhmm });
      continue;
    }

    const prayer = String(slotEl.querySelector("[data-slot-prayer]")?.value || "").trim().toLowerCase();
    if (!["imsak", "fajr", "sunrise", "dhuhr", "asr", "sunset", "maghrib", "isha"].includes(prayer)) {
      setReminderStatus("Please select a valid prayer for each prayer-based slot.", true);
      return null;
    }
    const direction = String(slotEl.querySelector("[data-slot-direction]")?.value || "after").toLowerCase();
    if (direction !== "before" && direction !== "after") {
      setReminderStatus("Please select Before or After for each prayer slot.", true);
      return null;
    }
    let offsetAbs = Number(slotEl.querySelector("[data-slot-offset]")?.value || 0);
    if (!Number.isInteger(offsetAbs)) {
      setReminderStatus("Offset must be a whole number of minutes.", true);
      return null;
    }
    offsetAbs = Math.max(0, Math.min(180, offsetAbs));
    const offset = direction === "before" ? -offsetAbs : offsetAbs;
    slots.push({ type: "prayer", prayer, offset_minutes: offset });
  }
  return slots.slice(0, 3);
}

async function loadReminderSettings() {
  if (!sessionToken) {
    applyReminderSlotsToEditors(DEFAULT_REMINDER_SLOTS);
    syncReminderAuthState();
    return;
  }

  try {
    const response = await fetch(API.notificationSettings, { headers: authHeaders() });
    if (response.status === 401) {
      await logout();
      return;
    }
    if (!response.ok) {
      throw new Error(`Unable to load reminder settings (${response.status}).`);
    }
    const data = await response.json();
    const slots = normalizeReminderSlots(data?.settings?.slots);
    applyReminderSlotsToEditors(slots);
    setReminderStatus("Reminder settings loaded.");
  } catch (error) {
    setReminderStatus(`Unable to load reminder settings: ${error.message}`, true);
  } finally {
    syncReminderAuthState();
  }
}

async function saveReminderSettings() {
  if (!sessionToken) {
    setReminderStatus("Login required to save notification settings.", true);
    return;
  }

  const slots = collectReminderSlotsFromEditors();
  if (!slots) return;

  try {
    const response = await fetch(API.notificationSettings, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ slots }),
    });
    if (response.status === 401) {
      await logout();
      return;
    }
    if (!response.ok) {
      throw new Error(`Save failed (${response.status}).`);
    }
    const data = await response.json();
    applyReminderSlotsToEditors(normalizeReminderSlots(data?.settings?.slots));
    setReminderStatus("Reminder settings saved.");
  } catch (error) {
    setReminderStatus(`Unable to save settings: ${error.message}`, true);
  }
}

async function boot() {
  try {
    await getDb();
    await loadSavedMeta();
    await registerServiceWorker();
    await loadBackendConfig();
    await initLocationPermissionAndRefresh();
    await restoreSession();
    await refreshPushSubscriptionState();
    renderAuthState();
    initReminderEditors();
    await loadReminderSettings();
    initGoogleSignIn();
    syncPushButtonState();

    initRamadanSelectors();
    await loadLocalData();
    renderAll();

    await renderRamadanDayMeta();
    await renderPrayerTimes();
    await handleInitialRoute();
    setStatus("Sedia. (Ready)");
  } catch (error) {
    console.error(error);
    setStatus(`Ralat: ${error.message}`);
  }
}

function initRamadanSelectors() {
  const yearsAsc = getConfiguredYearsAsc();
  const yearsDesc = [...yearsAsc].reverse();
  const currentYear = Number(todayInTimezone().slice(0, 4));
  const defaultYear = yearsDesc.includes(currentYear) ? currentYear : yearsDesc[0];

  state.selectedRamadanYear = defaultYear;
  const { year, monthIndex } = getIsoParts(RAMADAN_YEAR_CONFIG[defaultYear].start);
  state.viewMonthYear = year;
  state.viewMonthIndex = monthIndex;

  if (els.ramadanYearSelect) {
    els.ramadanYearSelect.innerHTML = yearsDesc.map((y) => `<option value="${y}">${y}</option>`).join("");
    els.ramadanYearSelect.value = String(defaultYear);
  }
  if (els.overrideYearSelect) {
    els.overrideYearSelect.innerHTML = yearsDesc.map((y) => `<option value="${y}">${y}</option>`).join("");
    els.overrideYearSelect.value = String(defaultYear);
  }
}

function setSelectedRamadanYear(year, jumpToWindowStart) {
  if (!RAMADAN_YEAR_CONFIG[year]) return;
  state.selectedRamadanYear = year;
  if (els.ramadanYearSelect) els.ramadanYearSelect.value = String(year);
  if (jumpToWindowStart) {
    const parts = getIsoParts(RAMADAN_YEAR_CONFIG[year].start);
    state.viewMonthYear = parts.year;
    state.viewMonthIndex = parts.monthIndex;
  }
}

function shiftViewMonth(delta) {
  const next = new Date(Date.UTC(state.viewMonthYear, state.viewMonthIndex + delta, 1));
  state.viewMonthYear = next.getUTCFullYear();
  state.viewMonthIndex = next.getUTCMonth();
}

async function loadLocalData() {
  const [rawLogs, rawManual] = await Promise.all([getAllLogsRaw(), getMeta("requiredManualByYear")]);
  state.logsByDate = new Map();
  const todayIso = todayInTimezone();
  for (const item of rawLogs) {
    const log = normalizeStoredLog(item);
    if (!log || !log.status) continue;
    if (log.date > todayIso) {
      await dbRun("logs", "readwrite", (store) => store.delete(log.date));
      continue;
    }
    state.logsByDate.set(log.date, log);
  }
  state.requiredManualByYear = sanitizeRequiredManualMap(rawManual);
}

function renderAll() {
  if (els.ramadanViewTitle) {
    els.ramadanViewTitle.textContent = `Ramadhan ${state.selectedRamadanYear}`;
  }
  renderCalendar();
  renderRamadanSummaryTable();
  renderGantiSummaryTable();
}

function renderCalendar() {
  if (!els.calendarGrid || !els.calendarMonthLabel) return;
  const todayIso = todayInTimezone();

  const monthDate = new Date(Date.UTC(state.viewMonthYear, state.viewMonthIndex, 1));
  els.calendarMonthLabel.textContent = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(monthDate)
    .toUpperCase();

  const cells = buildCalendarCells(state.viewMonthYear, state.viewMonthIndex);
  els.calendarGrid.innerHTML = cells
    .map((cell) => {
      const inWindow = isWithinRamadanWindow(cell.iso, state.selectedRamadanYear);
      const isFuture = cell.iso > todayIso;
      const log = isFuture ? null : state.logsByDate.get(cell.iso);
      let mark = "&nbsp;";
      let markClass = "day-mark";

      if (log?.status === "fasted") {
        mark = "&#10003;";
        markClass += " fasted";
      } else if (log?.status === "not_fasted") {
        mark = "&#10007;";
        markClass += " not-fasted";
      } else if (inWindow) {
        mark = "?";
        markClass += " unknown";
      }

      const classes = [
        "day-cell",
        cell.isCurrentMonth ? "" : "outside-month",
        inWindow ? "in-ramadan" : "",
        isFuture ? "future-date" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return `<button type="button" class="${classes}" data-date="${cell.iso}" ${
        isFuture ? "disabled" : ""
      } aria-disabled="${isFuture ? "true" : "false"}">
        <span class="day-num">${cell.day}</span>
        <span class="${markClass}">${mark}</span>
      </button>`;
    })
    .join("");
}

function buildCalendarCells(year, monthIndex) {
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const monthDays = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const prevMonthDays = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const cells = [];

  for (let i = 0; i < 42; i += 1) {
    let d;
    let y = year;
    let m = monthIndex;
    let isCurrentMonth = true;

    if (i < firstWeekday) {
      isCurrentMonth = false;
      d = prevMonthDays - firstWeekday + i + 1;
      const prev = new Date(Date.UTC(year, monthIndex - 1, 1));
      y = prev.getUTCFullYear();
      m = prev.getUTCMonth();
    } else if (i >= firstWeekday + monthDays) {
      isCurrentMonth = false;
      d = i - (firstWeekday + monthDays) + 1;
      const next = new Date(Date.UTC(year, monthIndex + 1, 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth();
    } else {
      d = i - firstWeekday + 1;
    }

    cells.push({
      day: d,
      iso: isoDateFromParts(y, m, d),
      isCurrentMonth,
    });
  }

  return cells;
}

function renderRamadanSummaryTable() {
  if (!els.ramadanSummaryBody) return;
  const year = state.selectedRamadanYear;
  const summary = buildRamadanSummaryForYear(year);
  const cfg = RAMADAN_YEAR_CONFIG[year];
  const range = `${formatDayMonth(cfg.start)}-${formatDayMonth(cfg.end)}`;

  els.ramadanSummaryBody.innerHTML = `<tr>
    <td><strong>Ramadhan ${year} (${range})</strong></td>
    <td><strong>${summary.completedLogged}</strong></td>
    <td><strong>${summary.missedLogged}</strong></td>
    <td><strong>${summary.unlogged}</strong></td>
  </tr>`;
}

function renderGantiSummaryTable() {
  if (!els.gantiSummaryBody) return;
  const metrics = buildGantiMetricsByYear(getAllLogsArray(), state.requiredManualByYear);
  els.gantiSummaryBody.innerHTML = getConfiguredYearsAsc()
    .map((year) => {
      const row = metrics[year];
      return `<tr>
        <td>${year}</td>
        <td>${row.effectiveRequired}</td>
        <td>${row.doneGanti}</td>
        <td>${row.remaining}</td>
        <td>${row.source}</td>
      </tr>`;
    })
    .join("");
}
function openDayDialog(dateIso, options = {}) {
  if (!els.checkinDialog || !els.checkinPrompt || !els.checkinMessage) return;
  const existing = state.logsByDate.get(dateIso) || null;

  state.activeDate = dateIso;
  state.activeStatus = existing?.status || null;
  state.activeTag = existing?.tag || null;

  els.checkinPrompt.textContent = `${formatDateWithWeekday(dateIso)} (Date)`;
  if (options.message) {
    els.checkinMessage.textContent = options.message;
  } else if (existing?.status === "fasted") {
    els.checkinMessage.textContent = "Status semasa: Puasa. (Current status: Fasted.)";
  } else if (existing?.status === "not_fasted") {
    els.checkinMessage.textContent = "Status semasa: Tak puasa. (Current status: Not fasted.)";
  } else {
    els.checkinMessage.textContent = "Belum log untuk tarikh ini. (No log recorded for this date.)";
  }

  renderTagSection();
  if (!els.checkinDialog.open) els.checkinDialog.showModal();
}

function closeDayDialog() {
  if (els.checkinDialog?.open) els.checkinDialog.close();
  state.activeDate = null;
  state.activeStatus = null;
  state.activeTag = null;
}

function shouldShowTagSectionForActiveDate() {
  if (!state.activeDate || state.activeStatus !== "fasted") return false;
  return !isWithinRamadanWindow(state.activeDate, state.selectedRamadanYear);
}

function renderTagSection() {
  if (!els.tagSection || !els.checkinDialog) return;
  const show = shouldShowTagSectionForActiveDate();
  els.tagSection.style.display = show ? "block" : "none";
  if (!show) return;

  const selected = state.activeTag || "none";
  for (const btn of els.checkinDialog.querySelectorAll("button[data-tag]")) {
    btn.classList.toggle("active", btn.dataset.tag === selected);
  }
}

async function handleDialogAnswer(answer) {
  if (!state.activeDate || isSubmittingDialogAction) return;
  isSubmittingDialogAction = true;

  try {
    const date = state.activeDate;
    if (date > todayInTimezone()) {
      els.checkinMessage.textContent =
        "Tarikh akan datang tidak boleh dilog. (Future dates cannot be logged.)";
      return;
    }
    const pending = state.pendingCheckinRequest;

    if (answer === "clear") {
      if (pending?.allowClear === false) {
        els.checkinMessage.textContent = "Sila pilih Puasa atau Tak puasa. (Please choose Fasted or Not fasted.)";
        return;
      }
      await clearDayLog(date);
      renderAll();
      closeDayDialog();
      return;
    }

    if (answer !== "fasted" && answer !== "not_fasted") return;

    const prev = state.logsByDate.get(date);
    const next = {
      date,
      status: answer,
      tag: null,
      gantiYear: null,
      updatedAt: new Date().toISOString(),
    };

    if (answer === "fasted" && !isWithinRamadanWindow(date, state.selectedRamadanYear)) {
      next.tag = prev?.tag === "ganti" || prev?.tag === "sunnah" ? prev.tag : null;
      next.gantiYear = next.tag === "ganti" && Number.isInteger(prev?.gantiYear) ? prev.gantiYear : null;
    }

    await saveDayLog(next);
    state.activeStatus = next.status;
    state.activeTag = next.tag;

    renderAll();
    await maybeSyncTodayCheckin(date, next.status);

    if (answer === "fasted" && shouldShowTagSectionForActiveDate()) {
      els.checkinMessage.textContent = "Log disimpan. Pilih tag jika perlu. (Saved. Choose a tag if needed.)";
      renderTagSection();
    } else {
      closeDayDialog();
    }

    if (pending && pending.date === date && answer !== "clear") {
      state.pendingCheckinRequest = null;
      if (pending.redirectToHome) window.location.href = `${BASE_PATH}`;
    }
  } catch (error) {
    console.error(error);
    setStatus(`Tidak dapat simpan log: ${error.message}`);
  } finally {
    isSubmittingDialogAction = false;
  }
}

async function handleTagSelection(tag) {
  if (!state.activeDate || isSubmittingDialogAction) return;
  if (!shouldShowTagSectionForActiveDate()) return;
  if (!["ganti", "sunnah", "none"].includes(tag)) return;

  isSubmittingDialogAction = true;
  try {
    const date = state.activeDate;
    const current = state.logsByDate.get(date);
    if (!current || current.status !== "fasted") return;

    const next = { ...current, updatedAt: new Date().toISOString() };

    if (tag === "none") {
      next.tag = null;
      next.gantiYear = null;
      els.checkinMessage.textContent = "Tag dibuang. (Tag removed.)";
    } else if (tag === "sunnah") {
      next.tag = "sunnah";
      next.gantiYear = null;
      els.checkinMessage.textContent = "Ditanda sebagai Sunat. (Tagged as Sunnah.)";
    } else {
      const assignedYear = findOldestRemainingYear(date);
      if (!assignedYear) {
        next.tag = "sunnah";
        next.gantiYear = null;
        els.checkinMessage.textContent =
          "Tiada baki ganti. Pilih Sunat atau set Perlu Ganti dalam Tetapan. (No remaining ganti. Choose Sunnah or set Required in Settings.)";
      } else {
        next.tag = "ganti";
        next.gantiYear = assignedYear;
        els.checkinMessage.textContent = `Ditanda sebagai Ganti untuk Ramadhan ${assignedYear}. (Tagged as make-up for Ramadan ${assignedYear}.)`;
      }
    }

    await saveDayLog(next);
    state.activeTag = next.tag;
    renderAll();
    renderTagSection();
  } catch (error) {
    console.error(error);
    setStatus(`Tidak dapat kemas kini tag: ${error.message}`);
  } finally {
    isSubmittingDialogAction = false;
  }
}

function buildRamadanSummaryForYear(year) {
  const cfg = RAMADAN_YEAR_CONFIG[year];
  if (!cfg) return { completedLogged: 0, missedLogged: 0, unlogged: 0, totalDays: 0 };

  const dates = dateRange(cfg.start, cfg.end);
  let completedLogged = 0;
  let missedLogged = 0;
  let unlogged = 0;

  for (const date of dates) {
    const log = state.logsByDate.get(date);
    if (log?.status === "fasted") completedLogged += 1;
    else if (log?.status === "not_fasted") missedLogged += 1;
    else unlogged += 1;
  }

  return { completedLogged, missedLogged, unlogged, totalDays: dates.length };
}

function buildGantiMetricsByYear(logs, requiredManualByYear) {
  const out = {};
  for (const year of getConfiguredYearsAsc()) {
    const cfg = RAMADAN_YEAR_CONFIG[year];
    let missedLogged = 0;

    for (const log of logs) {
      if (log.status === "not_fasted" && isWithinIsoRange(log.date, cfg.start, cfg.end)) {
        missedLogged += 1;
      }
    }

    const manual = parseRequiredManualValue(requiredManualByYear?.[year]);
    out[year] = {
      missedLogged,
      requiredManual: manual,
      effectiveRequired: manual === null ? missedLogged : manual,
      doneGanti: 0,
      remaining: 0,
      source: manual === null ? "Logs" : "Manual",
    };
  }

  for (const log of logs) {
    if (log.status === "fasted" && log.tag === "ganti" && Number.isInteger(log.gantiYear) && out[log.gantiYear]) {
      out[log.gantiYear].doneGanti += 1;
    }
  }

  for (const year of getConfiguredYearsAsc()) {
    const row = out[year];
    row.remaining = Math.max(row.effectiveRequired - row.doneGanti, 0);
  }

  return out;
}

function findOldestRemainingYear(excludeDate) {
  const logs = getAllLogsArray().filter((item) => item.date !== excludeDate);
  const metrics = buildGantiMetricsByYear(logs, state.requiredManualByYear);
  for (const year of getConfiguredYearsAsc()) {
    if (metrics[year].remaining > 0) return year;
  }
  return null;
}

function openOverrideDialog() {
  if (!els.overrideDialog || !els.overrideYearSelect || !els.overrideRequiredInput) return;
  const year = state.selectedRamadanYear;
  els.overrideYearSelect.value = String(year);
  syncOverrideFormForYear(year);
  clearOverrideError();
  els.overrideDialog.showModal();
}

function syncOverrideFormForYear(year) {
  const manual = parseRequiredManualValue(state.requiredManualByYear?.[year]);
  if (els.overrideRequiredInput) {
    els.overrideRequiredInput.value = manual === null ? "" : String(manual);
  }
  const metrics = buildGantiMetricsByYear(getAllLogsArray(), state.requiredManualByYear);
  const missed = metrics[year]?.missedLogged ?? 0;
  if (els.overrideMissedLine) {
    els.overrideMissedLine.textContent = `Missed (logged) for Ramadhan ${year}: ${missed}`;
  }
  clearOverrideError();
}

function clearOverrideError() {
  if (els.overrideError) els.overrideError.textContent = "";
}

async function saveOverride() {
  if (!els.overrideYearSelect || !els.overrideRequiredInput) return;
  const year = Number(els.overrideYearSelect.value);
  const raw = String(els.overrideRequiredInput.value || "").trim();

  if (!/^\d+$/.test(raw)) {
    if (els.overrideError) {
      els.overrideError.textContent = "Masukkan nombor bulat 0 atau lebih. (Enter a whole number 0 or more.)";
    }
    return;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    if (els.overrideError) {
      els.overrideError.textContent = "Masukkan nombor bulat 0 atau lebih. (Enter a whole number 0 or more.)";
    }
    return;
  }

  state.requiredManualByYear = { ...state.requiredManualByYear, [year]: value };
  await setMeta("requiredManualByYear", state.requiredManualByYear);
  renderAll();
  els.overrideDialog?.close();
}

async function clearOverrideForFormYear() {
  if (!els.overrideYearSelect) return;
  const year = Number(els.overrideYearSelect.value);
  const next = { ...state.requiredManualByYear };
  delete next[year];
  state.requiredManualByYear = next;
  await setMeta("requiredManualByYear", state.requiredManualByYear);
  renderAll();
  els.overrideDialog?.close();
}

function currentRoute() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "checkin" || view === "summary") return view;
  const path = window.location.pathname;
  if (path.endsWith("/checkin")) return "checkin";
  if (path.endsWith("/summary")) return "summary";
  return "home";
}

async function handleInitialRoute() {
  const route = currentRoute();
  if (route === "summary") {
    els.summarySection?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (route === "checkin") {
    const date = normalizeIsoDate(new URLSearchParams(window.location.search).get("date") || "") || todayInTimezone();
    if (date > todayInTimezone()) {
      setStatus("Tarikh akan datang tidak dibenarkan. (Future date is not allowed.)");
      return;
    }
    state.pendingCheckinRequest = {
      date,
      allowCancel: true,
      allowClear: false,
      redirectToHome: true,
    };
    openDayDialog(date, {
      message: "Sila pilih status untuk tarikh ini. (Please choose a status for this date.)",
    });
  }
}

async function renderRamadanDayMeta() {
  if (!els.ramadanDayMeta) return;
  const year = state.selectedRamadanYear;
  const cfg = RAMADAN_YEAR_CONFIG[year];
  if (!cfg) {
    els.ramadanDayMeta.textContent = "Maklumat Ramadhan tidak ditemui. (Ramadan info unavailable.)";
    return;
  }

  const today = todayInTimezone();
  if (today < cfg.start) {
    els.ramadanDayMeta.textContent = `Ramadhan ${year} belum bermula. Mula: ${formatDateLong(cfg.start)}.`;
    return;
  }
  if (today > cfg.end) {
    els.ramadanDayMeta.textContent = `Ramadhan ${year} telah tamat. Tamat: ${formatDateLong(cfg.end)}.`;
    return;
  }

  const dayNo = dateRange(cfg.start, today).length;
  els.ramadanDayMeta.textContent = `Hari ${dayNo} Ramadhan ${year}. (Day ${dayNo})`;
}
async function loadBackendConfig() {
  try {
    const response = await fetch(API.config);
    if (!response.ok) throw new Error(`Cannot load backend config (${response.status}).`);
    const data = await response.json();
    vapidPublicKey = data.vapidPublicKey || null;
    googleClientId = data.googleClientId || null;
  } catch (error) {
    vapidPublicKey = null;
    googleClientId = null;
  }
}

function setStatus(text) {
  if (els.status) els.status.textContent = `Status: ${text}`;
}

function renderAuthState() {
  if (!els.authMeta || !els.googleSignIn || !els.logoutBtn) return;

  if (currentUser?.email) {
    const name = currentUser.name || currentUser.email;
    els.authMeta.textContent = `Masuk sebagai ${name}. (Signed in)`;
    els.googleSignIn.style.display = "none";
    els.logoutBtn.style.display = "inline-block";
    syncReminderAuthState();
    return;
  }

  els.authMeta.textContent = "Log masuk Google diperlukan untuk sync push. (Google login required for push sync.)";
  els.googleSignIn.style.display = "block";
  els.logoutBtn.style.display = "none";
  syncReminderAuthState();
}

function initGoogleSignIn() {
  if (!googleClientId || currentUser?.email || googleSignInRenderStarted) return;

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
          await loadReminderSettings();
          syncPushButtonState();
          setStatus("Log masuk Google berjaya. (Google login successful.)");
        } catch (error) {
          setStatus(`Log masuk Google gagal: ${error.message}`);
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
  if (!credential) throw new Error("Missing Google credential.");

  const response = await fetch(API.authGoogle, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) throw new Error(`Auth failed (${response.status}).`);

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
    if (!response.ok) throw new Error(`Session check failed (${response.status})`);
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
    applyReminderSlotsToEditors(DEFAULT_REMINDER_SLOTS);
    initGoogleSignIn();
    syncPushButtonState();
    setStatus("Log keluar berjaya. (Logged out.)");
  }
}

function authHeaders(extra = {}) {
  if (!sessionToken) return { ...extra };
  return { Authorization: `Bearer ${sessionToken}`, ...extra };
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("Service Worker is not supported in this browser.");
  await navigator.serviceWorker.register(`${BASE_PATH}sw.js?v=${APP_VERSION}`, { scope: BASE_PATH });
}

async function refreshPushSubscriptionState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    hasPushSubscription = false;
    syncPushButtonState();
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    hasPushSubscription = !!sub;
    await setMeta("subscriptionEndpoint", sub?.endpoint || null);
  } catch {
    hasPushSubscription = false;
  }
  syncPushButtonState();
}
async function enablePush() {
  const supportError = getEnablePushError();
  if (supportError) {
    setStatus(supportError);
    return;
  }

  try {
    if (!sessionToken) throw new Error("Login with Google first.");
    if (!vapidPublicKey) throw new Error("Backend config missing VAPID key.");

    setStatus("Meminta kebenaran notifikasi... (Requesting notification permission...)");
    const permission = await Notification.requestPermission();
    if (permission === "default") {
      setStatus("Prompt ditutup. Cuba lagi dan pilih Allow. (Prompt dismissed, try again.)");
      syncPushButtonState();
      return;
    }
    if (permission === "denied") {
      setStatus("Notifikasi disekat. Benarkan di tetapan browser. (Notifications are blocked.)");
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

    await setMeta("subscriptionEndpoint", subscription.endpoint);

    const response = await fetch(API.subscribe, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    if (response.status === 401) {
      await logout();
      throw new Error("Session expired. Please login again.");
    }
    if (!response.ok) throw new Error(`Subscribe failed (${response.status}).`);

    setStatus("Push aktif dan disimpan. (Push enabled and saved.)");
    hasPushSubscription = true;
    syncPushButtonState();
  } catch (error) {
    console.error(error);
    setStatus(`Enable Push gagal: ${error.message}`);
  }
}

async function disablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("Push is not supported in this browser.");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (!sub) {
      hasPushSubscription = false;
      syncPushButtonState();
      setStatus("Push sudah dimatikan. (Push is already disabled.)");
      return;
    }

    const endpoint = sub.endpoint || "";
    await sub.unsubscribe();
    await setMeta("subscriptionEndpoint", null);
    hasPushSubscription = false;

    if (sessionToken && endpoint) {
      const response = await fetch(API.unsubscribe, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ endpoint }),
      });
      if (response.status === 401) {
        await logout();
      } else if (!response.ok) {
        throw new Error(`Unsubscribe sync failed (${response.status}).`);
      }
    }

    syncPushButtonState();
    setStatus("Push dimatikan. (Push disabled.)");
  } catch (error) {
    console.error(error);
    setStatus(`Stop Push gagal: ${error.message}`);
  }
}

async function maybeSyncTodayCheckin(date, status) {
  if (!sessionToken) return;
  if (normalizeIsoDate(date) !== todayInTimezone()) return;

  const backendStatus = mapStatusToBackend(status);
  if (!backendStatus) return;

  try {
    const response = await fetch(API.checkin, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ date, status: backendStatus }),
    });

    if (response.status === 401) {
      await logout();
      return;
    }
    if (!response.ok) throw new Error(`Check-in sync failed (${response.status}).`);
  } catch (error) {
    console.error(error);
    setStatus(`Log tempatan disimpan, sync gagal: ${error.message}`);
  }
}

function syncPushButtonState() {
  if (!els.enablePushBtn) return;
  const environmentError = getPushEnvironmentError();
  const enableError = getEnablePushError();
  const canEnable = !enableError && !!vapidPublicKey;
  els.enablePushBtn.disabled = !canEnable || hasPushSubscription;
  els.enablePushBtn.title = enableError || (vapidPublicKey ? "" : "Missing backend VAPID config.");
  if (els.disablePushBtn) {
    els.disablePushBtn.disabled = !!environmentError || !hasPushSubscription;
    els.disablePushBtn.title = environmentError || "";
  }
}

function getPushEnvironmentError() {
  if (!window.isSecureContext) return "Push requires HTTPS (or localhost).";
  if (!("Notification" in window) || !("PushManager" in window)) return "Push is not supported in this browser.";
  if (isIosBrowser() && !isStandaloneDisplayMode()) {
    return "On iPhone/iPad, install this app to Home Screen to enable push.";
  }
  return null;
}

function getEnablePushError() {
  if (!sessionToken || !currentUser?.email) return "Login with Google first.";
  const environmentError = getPushEnvironmentError();
  if (environmentError) {
    return environmentError;
  }
  if (Notification.permission === "denied") {
    return "Notifications are blocked. Open browser site settings and allow Notifications.";
  }
  return null;
}

function isIosBrowser() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandaloneDisplayMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
async function initLocationPermissionAndRefresh() {
  if (!("geolocation" in navigator)) return;

  const permissionState = await getGeolocationPermissionState();
  if (!locationPermissionAsked && permissionState !== "denied") {
    try {
      setStatus("Meminta kebenaran lokasi... (Requesting location permission...)");
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
  if (!navigator.permissions?.query) return "unknown";
  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state;
  } catch {
    return "unknown";
  }
}

async function refreshCurrentLocation() {
  const pos = await getCurrentPosition();
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const label = await reverseGeocodeLabel(lat, lon);
  if (!label) return;

  currentLocationLabel = label;
  await setMeta("currentLocationLabel", currentLocationLabel);
  if (prayerTimesPayload) renderPrayerMetaLine(prayerTimesPayload);
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 0,
    });
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
    if (label) return label;
  } catch {
    // Fallback below.
  }
  return `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`;
}
function renderPrayerMetaLine(payload) {
  if (!els.prayerMeta) return;
  const dateText = formatDateLong(payload.today);
  const location = currentLocationLabel || payload.location || "Current location";
  els.prayerMeta.textContent = `${location} - ${dateText}`;
}

async function renderPrayerTimes() {
  if (!els.prayerMeta) return;
  try {
    const data = await fetchJson(`${API.prayerTimes}?days=30`);
    prayerTimesPayload = data;
    renderPrayerMetaLine(data);
    if (els.prayerFooter) {
      els.prayerFooter.textContent = `Based on: ${data.source_name}. GMT+08:00${
        data.stale ? " - showing cached data while source refresh failed." : ""
      }`;
    }
    setPrayerViewMode(prayerViewMode);
  } catch (error) {
    console.error(error);
    els.prayerMeta.textContent = `Unable to load prayer times: ${error.message}`;
    if (els.prayerFooter) els.prayerFooter.textContent = "";
  }
}

function setPrayerViewMode(mode) {
  prayerViewMode = mode;
  if (!els.prayerTodayTab || !els.prayer30Tab || !els.prayerTodayView || !els.prayer30View) return;

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
  if (!els.prayerTodayView) return;
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
      (item) => `<article class="prayer-item"><h3>${item.label}</h3><p>${formatTimeDisplay(todayRow[item.key])}</p></article>`
    )
    .join("");
}

function renderPrayerTable(payload) {
  if (!els.prayerTableBody) return;
  const prayers = getPrayerFields(payload);
  const todayIso = normalizeIsoDate(payload.today) || todayInTimezone();

  if (els.prayerTableHeadRow) {
    els.prayerTableHeadRow.innerHTML = ["<th>Date</th>", ...prayers.map((item) => `<th>${item.label}</th>`)].join("");
  }

  els.prayerTableBody.innerHTML = payload.items
    .map((item) => {
      const isToday = normalizeIsoDate(item.date) === todayIso;
      const cells = prayers.map((prayer) => `<td>${formatTimeDisplay(item[prayer.key])}</td>`).join("");
      return `<tr class="${isToday ? "prayer-row-today" : ""}"><td>${formatDateShort(item.date)}</td>${cells}</tr>`;
    })
    .join("");
}
function getConfiguredYearsAsc() {
  return Object.keys(RAMADAN_YEAR_CONFIG)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item))
    .sort((a, b) => a - b);
}

function isWithinRamadanWindow(dateIso, year) {
  const cfg = RAMADAN_YEAR_CONFIG[year];
  if (!cfg) return false;
  return isWithinIsoRange(dateIso, cfg.start, cfg.end);
}

function isWithinIsoRange(dateIso, startIso, endIso) {
  return dateIso >= startIso && dateIso <= endIso;
}

function getAllLogsArray() {
  return Array.from(state.logsByDate.values())
    .filter((item) => item && item.date && (item.status === "fasted" || item.status === "not_fasted"))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function saveDayLog(log) {
  const normalized = normalizeStoredLog(log);
  if (!normalized || !normalized.status) throw new Error("Invalid log payload.");
  if (normalized.date > todayInTimezone()) {
    throw new Error("Future date logging is disabled.");
  }
  await dbRun("logs", "readwrite", (store) => store.put(normalized));
  state.logsByDate.set(normalized.date, normalized);
}

async function clearDayLog(date) {
  await dbRun("logs", "readwrite", (store) => store.delete(date));
  state.logsByDate.delete(date);
}

function normalizeStoredLog(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = normalizeIsoDate(raw.date);
  const status = normalizeStatus(raw.status);
  if (!date || !status) return null;

  const tag = raw.tag === "ganti" || raw.tag === "sunnah" ? raw.tag : null;
  const gantiYear = tag === "ganti" && Number.isInteger(raw.gantiYear) ? raw.gantiYear : null;

  return {
    date,
    status,
    tag,
    gantiYear,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function normalizeStatus(value) {
  if (value === "fasted" || value === "fasting") return "fasted";
  if (value === "not_fasted" || value === "not_fasting") return "not_fasted";
  return null;
}

function mapStatusToBackend(status) {
  if (status === "fasted") return "fasting";
  if (status === "not_fasted") return "not_fasting";
  return null;
}

function sanitizeRequiredManualMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const year of getConfiguredYearsAsc()) {
    const value = parseRequiredManualValue(raw[year]);
    if (value !== null) out[year] = value;
  }
  return out;
}

function parseRequiredManualValue(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function dateRange(startIso, endIso) {
  const output = [];
  const cursor = new Date(`${startIso}T12:00:00Z`);
  const end = new Date(`${endIso}T12:00:00Z`);

  while (cursor <= end) {
    output.push(toIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return output;
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

function formatDateLong(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
}

function formatDateWithWeekday(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
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

function formatDayMonth(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "short",
  }).format(d);
}

function normalizeIsoDate(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

function getIsoParts(isoDate) {
  const [year, month, day] = isoDate.split("-").map((item) => Number(item));
  return { year, monthIndex: month - 1, day };
}

function isoDateFromParts(year, monthIndex, day) {
  const d = new Date(Date.UTC(year, monthIndex, day));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function getPrayerFields(payload) {
  if (!payload || !Array.isArray(payload.prayer_fields)) return DEFAULT_PRAYER_FIELDS;

  const normalized = payload.prayer_fields
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.key === "string" &&
        String(item.key).toLowerCase() !== "midnight"
    )
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
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
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
    const req = worker(store);

    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error || req?.error);
  });
}

async function getAllLogsRaw() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("logs", "readonly");
    const req = tx.objectStore("logs").getAll();
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
    const req = tx.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

async function loadSavedMeta() {
  sessionToken = await getMeta("sessionToken");
  currentUser = (await getMeta("currentUser")) || null;
  hasPushSubscription = !!(await getMeta("subscriptionEndpoint"));
  currentLocationLabel = (await getMeta("currentLocationLabel")) || null;
  locationPermissionAsked = (await getMeta("locationPermissionAsked")) === true;
}
