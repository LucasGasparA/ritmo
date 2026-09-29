const $ = (selector) => document.querySelector(selector);
const MINUTE = 60 * 1000;

const state = {
  settings: { weeklyCapacity: 37.5, workdays: [1, 2, 3, 4, 5], workPeriods: [{ start: "09:00", end: "12:00" }, { start: "13:30", end: "18:00" }], ignoreAllDay: true },
  cache: null,
  connected: false,
};

function startOfWeek() {
  const date = new Date();
  const day = date.getDay();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return date;
}

function weekBounds() {
  const start = startOfWeek();
  return { start, end: new Date(start.getTime() + 7 * 24 * 60 * MINUTE) };
}

function formatHours(minutes) {
  const value = Math.max(0, Math.round(minutes));
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!rest) return `${hours}h`;
  if (!hours) return `${rest}min`;
  return `${hours}h ${String(rest).padStart(2, "0")}min`;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function normalizeSettings(settings = {}) {
  const normalized = { ...state.settings, ...settings };
  if (!Array.isArray(settings.workPeriods) || settings.workPeriods.length !== 2) {
    normalized.workPeriods = [
      { start: settings.workStart || "09:00", end: "12:00" },
      { start: "13:30", end: settings.workEnd || "18:00" },
    ];
  }
  const dailyCapacity = normalized.workPeriods.reduce((sum, period) => (
    sum + Math.max(0, timeToMinutes(period.end) - timeToMinutes(period.start))
  ), 0);
  normalized.weeklyCapacity = dailyCapacity * normalized.workdays.length / 60;
  return normalized;
}

function formatPeriod() {
  const { start, end } = weekBounds();
  const lastDay = new Date(end.getTime() - 24 * 60 * MINUTE);
  const first = start.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
  const last = lastDay.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
  return `${first} – ${last}`;
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#9aa0a6";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function showView(view) {
  $("#loadingState").hidden = view !== "loading";
  $("#disconnectedState").hidden = view !== "disconnected";
  $("#summaryState").hidden = view !== "summary";
  $("#refreshButton").hidden = view === "disconnected";
}

function showError(message) {
  const element = $("#errorMessage");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(showError.timeout);
  showError.timeout = setTimeout(() => { element.hidden = true; }, 4200);
}

function labelFor(id) {
  return state.cache?.labels?.find((label) => label.id === id) || { id: "unclassified", name: "Sem classificação", color: "#9aa0a6" };
}

function eventMinutes(event) {
  if (event.responseStatus === "declined") return 0;
  if (event.allDay && state.settings.ignoreAllDay) return 0;
  if (event.allDay) return state.settings.weeklyCapacity * 60 / Math.max(1, state.settings.workdays.length);
  return Math.max(0, (new Date(event.end) - new Date(event.start)) / MINUTE);
}

function dateAtTime(date, value) {
  const result = new Date(date);
  const [hours, minutes] = String(value).split(":").map(Number);
  result.setHours(hours, minutes, 0, 0);
  return result.getTime();
}

function mergedIntervalMinutes(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals.sort((a, b) => a.start - b.start);
  let total = 0;
  let currentStart = sorted[0].start;
  let currentEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= currentEnd) currentEnd = Math.max(currentEnd, interval.end);
    else {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  return (total + currentEnd - currentStart) / MINUTE;
}

function calculateOccupancy(events) {
  const weekStart = startOfWeek();
  const periods = state.settings.workPeriods || [{ start: "09:00", end: "12:00" }, { start: "13:30", end: "18:00" }];
  let total = 0;
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const calendarDay = dayIndex === 6 ? 0 : dayIndex + 1;
    if (!state.settings.workdays.includes(calendarDay)) continue;
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + dayIndex);
    const intervals = [];
    events.forEach((event) => {
      if (event.responseStatus === "declined" || event.transparency === "transparent") return;
      if (event.allDay && state.settings.ignoreAllDay) return;
      const eventStart = new Date(event.start).getTime();
      const eventEnd = new Date(event.end).getTime();
      if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd <= eventStart) return;
      periods.forEach((period) => {
        const clippedStart = Math.max(eventStart, dateAtTime(day, period.start));
        const clippedEnd = Math.min(eventEnd, dateAtTime(day, period.end));
        if (clippedEnd > clippedStart) intervals.push({ start: clippedStart, end: clippedEnd });
      });
    });
    total += mergedIntervalMinutes(intervals);
  }
  return total;
}

function analyze() {
  const categories = new Map();
  let total = 0;
  let meetings = 0;
  let unexpected = 0;
  const events = (state.cache?.events || []).filter((event) => event.responseStatus !== "declined");
  events.forEach((event) => {
    const minutes = eventMinutes(event);
    if (!minutes) return;
    total += minutes;
    const label = labelFor(event.labelId);
    const entry = categories.get(label.id) || { ...label, minutes: 0 };
    entry.minutes += minutes;
    categories.set(label.id, entry);
    const name = label.name.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (name === "reunioes" || name === "reuniao") meetings += minutes;
    if (name.startsWith("imprevisto")) unexpected += minutes;
  });
  return { total, occupied: calculateOccupancy(events), meetings, unexpected, events, categories: [...categories.values()].sort((a, b) => b.minutes - a.minutes) };
}

function renderSummary() {
  const analysis = analyze();
  const capacity = state.settings.weeklyCapacity * 60;
  const free = Math.max(0, capacity - analysis.occupied);
  const ratio = capacity ? Math.min(1, analysis.occupied / capacity) : 0;
  $("#weekPeriod").textContent = formatPeriod();
  $("#totalHours").textContent = formatHours(analysis.occupied);
  $("#freeHours").textContent = formatHours(free);
  $("#capacityHours").textContent = formatHours(capacity);
  $("#meetingHours").textContent = formatHours(analysis.meetings);
  $("#unexpectedHours").textContent = formatHours(analysis.unexpected);
  $("#eventCount").textContent = `${analysis.events.length} ${analysis.events.length === 1 ? "evento" : "eventos"}`;
  $("#capacityRing").style.strokeDashoffset = String(282.74 * (1 - ratio));
  const max = analysis.categories[0]?.minutes || 1;
  $("#categoryList").innerHTML = analysis.categories.length
    ? analysis.categories.slice(0, 4).map((category) => `<div class="category-row">
        <i style="background:${safeColor(category.color)}"></i>
        <div class="category-info"><span class="category-name">${escapeHTML(category.name)}</span><span class="bar-track"><i class="bar-fill" style="display:block;width:${category.minutes / max * 100}%;background:${safeColor(category.color)}"></i></span></div>
        <span class="category-time">${formatHours(category.minutes)}</span>
      </div>`).join("")
    : '<div class="empty-categories">Nenhum compromisso registrado nesta semana.</div>';
  const syncedAt = new Date(state.cache.lastSync);
  $("#syncTime").textContent = `Atualizado às ${syncedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  showView("summary");
}

async function requestSync(interactive) {
  const { start, end } = weekBounds();
  const response = await chrome.runtime.sendMessage({
    type: "SYNC_CALENDAR",
    payload: { timeMin: start.toISOString(), timeMax: end.toISOString(), interactive },
  });
  if (!response?.ok) throw new Error(response?.error || "Não foi possível sincronizar sua agenda.");
  state.cache = response.cache;
  state.connected = true;
  renderSummary();
}

async function connect() {
  const button = $("#connectButton");
  button.disabled = true;
  button.lastChild.textContent = " Conectando…";
  try {
    await requestSync(true);
  } catch (error) {
    showError(error.message);
    showView("disconnected");
  } finally {
    button.disabled = false;
    button.lastChild.textContent = " Conectar Google Agenda";
  }
}

async function refresh() {
  const button = $("#refreshButton");
  button.classList.add("loading");
  try {
    await requestSync(false);
  } catch (error) {
    showError("Sua sessão precisa ser renovada. Clique em conectar novamente.");
    state.connected = false;
    showView("disconnected");
  } finally {
    button.classList.remove("loading");
  }
}

async function init() {
  $("#connectButton").addEventListener("click", connect);
  $("#refreshButton").addEventListener("click", refresh);
  $("#openDashboardButton").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    window.close();
  });
  const stored = await chrome.storage.local.get(["settings", "connected", "googleCache"]);
  state.settings = normalizeSettings(stored.settings || {});
  state.connected = Boolean(stored.connected);
  state.cache = stored.googleCache || null;
  const currentWeek = weekBounds().start.toISOString();
  if (!state.connected) {
    showView("disconnected");
    return;
  }
  if (state.cache?.weekStart === currentWeek) {
    renderSummary();
    requestSync(false).catch(() => {});
  } else {
    try {
      await requestSync(false);
    } catch (error) {
      state.connected = false;
      showView("disconnected");
    }
  }
}

init();
