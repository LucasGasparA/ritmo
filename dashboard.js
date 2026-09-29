const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const DEFAULT_SETTINGS = {
  weeklyCapacity: 37.5,
  workdays: [1, 2, 3, 4, 5],
  workPeriods: [
    { start: "09:00", end: "12:00" },
    { start: "13:30", end: "18:00" },
  ],
  ignoreAllDay: true,
};

const state = {
  weekOffset: 0,
  activeView: "overview",
  source: "disconnected",
  connected: false,
  syncing: false,
  comparisonLoading: false,
  comparison: null,
  labelsExpanded: false,
  settings: { ...DEFAULT_SETTINGS },
  labels: [],
  events: [],
  lastSync: new Date(),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function storageGet(keys) {
  if (globalThis.chrome?.storage?.local) return chrome.storage.local.get(keys);
  const result = {};
  for (const key of keys) {
    const value = localStorage.getItem(`ritmo:${key}`);
    if (value) result[key] = JSON.parse(value);
  }
  return Promise.resolve(result);
}

function storageSet(values) {
  if (globalThis.chrome?.storage?.local) return chrome.storage.local.set(values);
  Object.entries(values).forEach(([key, value]) => localStorage.setItem(`ritmo:${key}`, JSON.stringify(value)));
  return Promise.resolve();
}

function startOfWeek(date = new Date(), offset = 0) {
  const result = new Date(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() + diff + offset * 7);
  return result;
}

function weekBounds() {
  const start = startOfWeek(new Date(), state.weekOffset);
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

function safeColor(color, fallback = "#87938b") {
  return /^#[0-9a-f]{6}$/i.test(color || "") ? color : fallback;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatHours(minutes, detailed = false) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  if (!detailed && remainder === 0) return `${hours}h`;
  if (!detailed && hours === 0) return `${remainder}min`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${String(remainder).padStart(2, "0")}min`;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value) {
  const safe = Math.max(0, Math.min(23 * 60 + 59, Math.round(value)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function calculateWeeklyCapacity(workdays, workPeriods) {
  const dailyMinutes = workPeriods.reduce((total, period) => (
    total + Math.max(0, timeToMinutes(period.end) - timeToMinutes(period.start))
  ), 0);
  return dailyMinutes * workdays.length / 60;
}

function normalizeWorkPeriods(settings = {}) {
  if (Array.isArray(settings.workPeriods) && settings.workPeriods.length === 2) {
    const periods = settings.workPeriods.map((period) => ({ start: period?.start, end: period?.end }));
    const validTimes = periods.every((period) => (
      /^\d{2}:\d{2}$/.test(period.start || "")
      && /^\d{2}:\d{2}$/.test(period.end || "")
      && timeToMinutes(period.end) > timeToMinutes(period.start)
    ));
    if (validTimes && timeToMinutes(periods[1].start) >= timeToMinutes(periods[0].end)) {
      return periods;
    }
  }

  // Migra a configuração antiga (início, término e intervalo) para dois períodos.
  const outerStart = settings.workStart || DEFAULT_SETTINGS.workPeriods[0].start;
  const outerEnd = settings.workEnd || DEFAULT_SETTINGS.workPeriods[1].end;
  const outerStartMinutes = timeToMinutes(outerStart);
  const outerEndMinutes = timeToMinutes(outerEnd);
  const lunchStart = 12 * 60;
  const lunchEnd = 13 * 60 + 30;
  if (outerStartMinutes < lunchStart && outerEndMinutes > lunchEnd) {
    return [
      { start: outerStart, end: "12:00" },
      { start: "13:30", end: outerEnd },
    ];
  }
  return DEFAULT_SETTINGS.workPeriods.map((period) => ({ ...period }));
}

function normalizeSettings(settings = {}) {
  const candidateWorkdays = Array.isArray(settings.workdays) && settings.workdays.length
    ? [...new Set(settings.workdays.map(Number).filter((day) => day >= 0 && day <= 6))]
    : [];
  const workdays = candidateWorkdays.length ? candidateWorkdays : [...DEFAULT_SETTINGS.workdays];
  const workPeriods = normalizeWorkPeriods(settings);
  return {
    workdays,
    workPeriods,
    weeklyCapacity: calculateWeeklyCapacity(workdays, workPeriods),
    ignoreAllDay: settings.ignoreAllDay ?? DEFAULT_SETTINGS.ignoreAllDay,
  };
}

function getWorkPeriodsFromForm() {
  return [
    { start: $("#period1Start").value, end: $("#period1End").value },
    { start: $("#period2Start").value, end: $("#period2End").value },
  ];
}

function updateCapacityPreview() {
  const workdays = $$("#weekdayPicker input:checked").map((input) => Number(input.value));
  const capacity = calculateWeeklyCapacity(workdays, getWorkPeriodsFromForm());
  $("#capacityPreview").textContent = formatHours(capacity * 60, true);
  return capacity;
}

function ownResponseStatus(event) {
  return event.responseStatus || event.attendees?.find((attendee) => attendee.self)?.responseStatus || "";
}

function isDeclinedEvent(event) {
  return ownResponseStatus(event) === "declined";
}

function mapGoogleEvent(event) {
  return {
    id: event.id,
    title: event.summary || "Sem título",
    start: new Date(event.start?.dateTime || `${event.start?.date}T00:00:00`),
    end: new Date(event.end?.dateTime || `${event.end?.date}T00:00:00`),
    allDay: Boolean(event.start?.date),
    labelId: event.eventLabelId || "unclassified",
    htmlLink: event.htmlLink || "",
    responseStatus: ownResponseStatus(event),
    transparency: event.transparency || "opaque",
  };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatPeriod(start, end) {
  const sameMonth = start.getMonth() === new Date(end.getTime() - DAY).getMonth();
  const lastDay = new Date(end.getTime() - DAY);
  const startText = start.toLocaleDateString("pt-BR", { day: "2-digit", ...(sameMonth ? {} : { month: "short" }) });
  const endText = lastDay.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  return `${startText} – ${endText}`.replaceAll(".", "");
}

function getLabel(labelId) {
  return state.labels.find((label) => label.id === labelId) || {
    id: "unclassified",
    name: "Sem classificação",
    color: "#aeb6b0",
  };
}

function eventMinutes(event) {
  if (isDeclinedEvent(event)) return 0;
  if (event.allDay && state.settings.ignoreAllDay) return 0;
  if (event.allDay) return (state.settings.weeklyCapacity / state.settings.workdays.length) * 60;
  const { start, end } = weekBounds();
  const clippedStart = Math.max(new Date(event.start).getTime(), start.getTime());
  const clippedEnd = Math.min(new Date(event.end).getTime(), end.getTime());
  return Math.max(0, (clippedEnd - clippedStart) / MINUTE);
}

function macroCategory(label) {
  const lower = label.name.toLocaleLowerCase("pt-BR");
  if (lower.startsWith("imprevistos") || lower.startsWith("imprevisto")) {
    return { name: "Imprevistos", color: "#efb947" };
  }
  if (lower.includes("preparação")) return { name: "Preparação", color: label.color };
  if (lower.includes("takeaway")) return { name: "Takeaways", color: label.color };
  return { name: label.name, color: label.color };
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
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  return (total + currentEnd - currentStart) / MINUTE;
}

function calculateOccupancy() {
  const { start } = weekBounds();
  const daily = Array.from({ length: 7 }, () => 0);
  const periods = state.settings.workPeriods || DEFAULT_SETTINGS.workPeriods;

  daily.forEach((_value, dayIndex) => {
    const calendarDay = dayIndex === 6 ? 0 : dayIndex + 1;
    if (!state.settings.workdays.includes(calendarDay)) return;
    const day = new Date(start);
    day.setDate(start.getDate() + dayIndex);
    const intervals = [];

    state.events.forEach((event) => {
      if (isDeclinedEvent(event) || event.transparency === "transparent") return;
      if (event.allDay && state.settings.ignoreAllDay) return;
      const eventStart = new Date(event.start).getTime();
      const eventEnd = new Date(event.end).getTime();
      if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd <= eventStart) return;

      periods.forEach((period) => {
        const periodStart = dateAtTime(day, period.start);
        const periodEnd = dateAtTime(day, period.end);
        const clippedStart = Math.max(eventStart, periodStart);
        const clippedEnd = Math.min(eventEnd, periodEnd);
        if (clippedEnd > clippedStart) intervals.push({ start: clippedStart, end: clippedEnd });
      });
    });
    daily[dayIndex] = mergedIntervalMinutes(intervals);
  });

  return { daily, total: daily.reduce((sum, minutes) => sum + minutes, 0) };
}

function analyze() {
  const labels = new Map();
  const macros = new Map();
  const daily = Array.from({ length: 7 }, () => 0);
  let total = 0;

  state.events.forEach((event) => {
    const minutes = eventMinutes(event);
    if (!minutes) return;
    total += minutes;
    const label = getLabel(event.labelId);
    const labelEntry = labels.get(label.id) || { ...label, minutes: 0, count: 0 };
    labelEntry.minutes += minutes;
    labelEntry.count += 1;
    labels.set(label.id, labelEntry);

    const macro = macroCategory(label);
    const macroEntry = macros.get(macro.name) || { ...macro, minutes: 0 };
    macroEntry.minutes += minutes;
    macros.set(macro.name, macroEntry);

    const date = new Date(event.start);
    const index = (date.getDay() + 6) % 7;
    daily[index] += minutes;
  });

  const occupancy = calculateOccupancy();
  return {
    total,
    labels: [...labels.values()].sort((a, b) => b.minutes - a.minutes),
    macros: [...macros.values()].sort((a, b) => b.minutes - a.minutes),
    daily,
    occupiedTotal: occupancy.total,
    occupiedDaily: occupancy.daily,
  };
}

function comparisonEventMinutes(event, start, end) {
  if (isDeclinedEvent(event) || (event.allDay && state.settings.ignoreAllDay)) return 0;
  if (event.allDay) return state.settings.weeklyCapacity * 60 / Math.max(1, state.settings.workdays.length);
  const clippedStart = Math.max(new Date(event.start).getTime(), start.getTime());
  const clippedEnd = Math.min(new Date(event.end).getTime(), end.getTime());
  return Math.max(0, (clippedEnd - clippedStart) / MINUTE);
}

function summarizeComparisonWeek(events, labels, start, end) {
  const macros = new Map();
  let total = 0;
  let eventCount = 0;
  events.forEach((event) => {
    const minutes = comparisonEventMinutes(event, start, end);
    if (!minutes) return;
    eventCount += 1;
    total += minutes;
    const label = labels.find((item) => item.id === event.labelId) || { id: "unclassified", name: "Sem classificação", color: "#aeb6b0" };
    const macro = macroCategory(label);
    const entry = macros.get(macro.name) || { ...macro, minutes: 0 };
    entry.minutes += minutes;
    macros.set(macro.name, entry);
  });
  return { total, eventCount, macros: [...macros.values()].sort((a, b) => b.minutes - a.minutes) };
}

function comparisonMetric(summary, name) {
  return summary.macros.find((item) => item.name === name)?.minutes || 0;
}

function formatComparisonDelta(value, count = false) {
  if (!value) return "Sem mudança";
  const prefix = value > 0 ? "+" : "−";
  const amount = count ? Math.abs(value).toLocaleString("pt-BR") : formatHours(Math.abs(value), true);
  return `${prefix}${amount} vs. anterior`;
}

function renderComparisonPeriod() {
  const { start, end } = weekBounds();
  const previousStart = new Date(start);
  previousStart.setDate(previousStart.getDate() - 7);
  $("#comparisonPeriod").textContent = formatPeriod(start, end);
  $("#comparisonCaption").textContent = `Comparando com ${formatPeriod(previousStart, start)}`;
}

function setComparisonMessage(mode, message = "") {
  const container = $("#comparisonMessage");
  const action = $("#comparisonAction");
  $("#comparisonContent").hidden = true;
  container.hidden = false;
  container.classList.toggle("loading", mode === "loading");
  if (mode === "loading") {
    container.querySelector("h2").textContent = "Comparando suas semanas…";
    container.querySelector("p").textContent = "Buscando os compromissos reais no Google Agenda.";
    action.hidden = true;
  } else if (mode === "error") {
    container.querySelector("h2").textContent = "Não foi possível comparar agora";
    container.querySelector("p").textContent = message || "Tente atualizar os dados novamente.";
    action.textContent = "Tentar novamente";
    action.dataset.action = "retry";
    action.hidden = false;
  } else {
    container.querySelector("h2").textContent = "Conecte sua agenda para comparar";
    container.querySelector("p").textContent = "Usaremos seus compromissos reais das duas semanas, sem dados demonstrativos.";
    action.textContent = "Abrir configurações";
    action.dataset.action = "settings";
    action.hidden = false;
  }
}

function renderComparison(data) {
  const { current, previous, currentStart, currentEnd, previousStart } = data;
  const meetingsCurrent = comparisonMetric(current, "Reuniões");
  const meetingsPrevious = comparisonMetric(previous, "Reuniões");
  const unexpectedCurrent = comparisonMetric(current, "Imprevistos");
  const unexpectedPrevious = comparisonMetric(previous, "Imprevistos");
  const metrics = [
    { label: "Tempo registrado", current: current.total, previous: previous.total, value: formatHours(current.total, true), count: false },
    { label: "Reuniões", current: meetingsCurrent, previous: meetingsPrevious, value: formatHours(meetingsCurrent, true), count: false },
    { label: "Imprevistos", current: unexpectedCurrent, previous: unexpectedPrevious, value: formatHours(unexpectedCurrent, true), count: false },
    { label: "Compromissos", current: current.eventCount, previous: previous.eventCount, value: current.eventCount.toLocaleString("pt-BR"), count: true },
  ];
  $("#comparisonKpis").innerHTML = metrics.map((metric) => {
    const difference = metric.current - metric.previous;
    const direction = difference > 0 ? "up" : difference < 0 ? "down" : "neutral";
    return `<article class="comparison-kpi">
      <span>${metric.label}</span>
      <strong>${metric.value}</strong>
      <small class="${direction}">${formatComparisonDelta(difference, metric.count)}</small>
    </article>`;
  }).join("");

  const categories = new Map();
  previous.macros.forEach((item) => categories.set(item.name, { name: item.name, color: item.color, previous: item.minutes, current: 0 }));
  current.macros.forEach((item) => {
    const entry = categories.get(item.name) || { name: item.name, color: item.color, previous: 0, current: 0 };
    entry.current = item.minutes;
    entry.color = item.color;
    categories.set(item.name, entry);
  });
  const rows = [...categories.values()].sort((a, b) => Math.max(b.current, b.previous) - Math.max(a.current, a.previous));
  const maxMinutes = Math.max(1, ...rows.flatMap((row) => [row.current, row.previous]));
  $("#comparisonCategories").innerHTML = rows.length ? rows.slice(0, 9).map((row) => {
    const difference = row.current - row.previous;
    return `<div class="comparison-category-row">
      <div class="comparison-category-head">
        <span><i style="background:${safeColor(row.color)}"></i>${escapeHTML(row.name)}</span>
        <strong>${formatHours(row.current, true)}</strong>
        <small class="${difference > 0 ? "up" : difference < 0 ? "down" : "neutral"}">${formatComparisonDelta(difference)}</small>
      </div>
      <div class="comparison-bars"><span><i style="width:${row.current / maxMinutes * 100}%;background:${safeColor(row.color)}"></i></span><span><i style="width:${row.previous / maxMinutes * 100}%"></i></span></div>
    </div>`;
  }).join("") : '<div class="empty-state">Nenhum compromisso registrado nas duas semanas.</div>';

  const changes = rows.map((row) => ({ ...row, difference: row.current - row.previous }));
  const increase = [...changes].sort((a, b) => b.difference - a.difference)[0];
  const decrease = [...changes].sort((a, b) => a.difference - b.difference)[0];
  const totalDifference = current.total - previous.total;
  const readings = [];
  readings.push({ icon: totalDifference > 0 ? "↗" : totalDifference < 0 ? "↘" : "–", text: totalDifference === 0 ? "O tempo registrado ficou igual ao da semana anterior." : `Você registrou <strong>${formatHours(Math.abs(totalDifference), true)} ${totalDifference > 0 ? "a mais" : "a menos"}</strong> que na semana anterior.` });
  if (increase?.difference > 0) readings.push({ icon: "+", text: `<strong>${escapeHTML(increase.name)}</strong> foi o maior aumento: ${formatHours(increase.difference, true)}.` });
  if (decrease?.difference < 0) readings.push({ icon: "−", text: `<strong>${escapeHTML(decrease.name)}</strong> teve a maior redução: ${formatHours(Math.abs(decrease.difference), true)}.` });
  if (readings.length === 1) readings.push({ icon: "✓", text: "A distribuição por categorias permaneceu estável entre as duas semanas." });
  $("#comparisonReadings").innerHTML = readings.map((item) => `<div><span>${item.icon}</span><p>${item.text}</p></div>`).join("");

  $("#comparisonCaption").textContent = `${formatPeriod(currentStart, currentEnd)} · anterior: ${formatPeriod(previousStart, currentStart)}`;
  $("#comparisonMessage").hidden = true;
  $("#comparisonContent").hidden = false;
}

async function loadComparison({ force = false } = {}) {
  renderComparisonPeriod();
  if (!state.connected) {
    setComparisonMessage("disconnected");
    return;
  }
  const { start: currentStart, end: currentEnd } = weekBounds();
  const cacheKey = currentStart.toISOString();
  if (!force && state.comparison?.key === cacheKey) {
    renderComparison(state.comparison);
    return;
  }
  if (state.comparisonLoading) return;
  state.comparisonLoading = true;
  setComparisonMessage("loading");
  try {
    const token = await getAuthToken(false);
    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - 7);
    const params = new URLSearchParams({
      eventLabelVersion: "1",
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "2500",
      timeMin: previousStart.toISOString(),
      timeMax: currentEnd.toISOString(),
    });
    const eventData = await googleFetch(`calendars/primary/events?${params}`, token);
    const events = (eventData.items || [])
      .filter((event) => event.status !== "cancelled" && !isDeclinedEvent(event))
      .map(mapGoogleEvent);
    const data = {
      key: cacheKey,
      currentStart,
      currentEnd,
      previousStart,
      current: summarizeComparisonWeek(events, state.labels, currentStart, currentEnd),
      previous: summarizeComparisonWeek(events, state.labels, previousStart, currentStart),
    };
    state.comparison = data;
    renderComparison(data);
  } catch (error) {
    console.error(error);
    setComparisonMessage("error", error.message || "Não foi possível consultar o Google Agenda.");
  } finally {
    state.comparisonLoading = false;
  }
}

function render() {
  const analysis = analyze();
  const { start, end } = weekBounds();
  $("#currentPeriod").textContent = formatPeriod(start, end);
  renderComparisonPeriod();
  renderSource();
  renderKpis(analysis);
  renderDonut(analysis);
  renderCapacity(analysis);
  renderDaily(analysis);
  renderInsights(analysis);
  renderLabels(analysis);
  renderEvents();
  renderSyncTime();
}

function renderSource() {
  const pill = $("#sourcePill");
  pill.classList.toggle("connected", state.connected);
  pill.lastChild.textContent = state.connected ? " Google Agenda conectado" : " Agenda não conectada";
  const button = $("#connectButton");
  button.lastChild.textContent = state.connected ? " Google conectado" : " Conectar Google Agenda";
  button.title = state.connected ? "Clique para desconectar" : "Conectar Google Agenda";
  $("#calendarConnectionStatus").textContent = state.connected
    ? "Conectado em modo somente leitura"
    : "Conecte para carregar seus compromissos";
}

function icon(type) {
  const paths = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    alert: '<path d="M10.3 3.6 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    space: '<path d="M4 12h16M12 4v16"/><circle cx="12" cy="12" r="9"/>',
  };
  return `<svg viewBox="0 0 24 24">${paths[type]}</svg>`;
}

function renderKpis(analysis) {
  const capacity = state.settings.weeklyCapacity * 60;
  const free = Math.max(0, capacity - analysis.occupiedTotal);
  const unexpected = analysis.macros.find((item) => item.name === "Imprevistos")?.minutes || 0;
  const meetings = analysis.macros.find((item) => item.name === "Reuniões")?.minutes || 0;
  const cards = [
    { label: "Tempo registrado", value: formatHours(analysis.total, true), foot: `${state.events.length} compromissos na semana`, icon: "clock", color: "#8323a0", soft: "#f4eaf7" },
    { label: "Reuniões", value: formatHours(meetings, true), foot: analysis.total ? `${Math.round(meetings / analysis.total * 100)}% do tempo registrado` : "Nenhuma reunião", icon: "calendar", color: "#489d71", soft: "#e6f3eb" },
    { label: "Imprevistos", value: formatHours(unexpected, true), foot: analysis.total ? `${Math.round(unexpected / analysis.total * 100)}% da semana` : "Nenhum imprevisto", icon: "alert", color: "#e87445", soft: "#fff0e9", warn: true },
    { label: "Tempo restante", value: formatHours(free, true), foot: free ? "Horários vazios dentro da jornada" : "Jornada totalmente ocupada", icon: "space", color: "#4b82ce", soft: "#e9f0fa" },
  ];
  $("#kpiGrid").innerHTML = cards.map((card) => `
    <article class="kpi-card" style="--accent:${card.color};--accent-soft:${card.soft}">
      <div class="kpi-top"><span>${card.label}</span><span class="kpi-icon">${icon(card.icon)}</span></div>
      <strong class="kpi-value">${card.value}</strong>
      <div class="kpi-foot"><span class="trend ${card.warn ? "warn" : ""}">${card.warn ? "atenção" : "semana"}</span>${card.foot}</div>
    </article>
  `).join("");
}

function renderDonut(analysis) {
  const chart = $("#donutChart");
  const tooltip = $("#donutTooltip");
  const radius = 86;
  const circumference = 2 * Math.PI * radius;
  chart.innerHTML = `<circle class="track" cx="110" cy="110" r="${radius}"/>`;
  let offset = 0;
  analysis.macros.forEach((category, index) => {
    const length = analysis.total ? category.minutes / analysis.total * circumference : 0;
    const percent = analysis.total ? Math.round(category.minutes / analysis.total * 100) : 0;
    const label = `${category.name}: ${formatHours(category.minutes, true)}, ${percent}% do tempo`;
    chart.insertAdjacentHTML("beforeend", `<circle class="segment" data-index="${index}" tabindex="0" role="img" aria-label="${escapeHTML(label)}" cx="110" cy="110" r="${radius}" stroke="${safeColor(category.color)}" stroke-dasharray="${Math.max(0, length - 2)} ${circumference}" stroke-dashoffset="${-offset}"/>`);
    offset += length;
  });
  $("#donutHours").textContent = formatHours(analysis.total, true);
  const visible = analysis.macros.slice(0, 7);
  const legend = $("#categoryLegend");
  legend.innerHTML = visible.length ? visible.map((category, index) => `
    <div class="legend-row" data-index="${index}" tabindex="0">
      <i class="legend-color" style="background:${safeColor(category.color)}"></i>
      <span class="legend-name" title="${escapeHTML(category.name)}">${escapeHTML(category.name)}</span>
      <span class="legend-time">${formatHours(category.minutes, true)}</span>
      <span class="legend-percent">${analysis.total ? Math.round(category.minutes / analysis.total * 100) : 0}%</span>
    </div>
  `).join("") : '<div class="empty-state">Nenhum evento nesta semana.</div>';

  const segments = [...chart.querySelectorAll(".segment")];
  const rows = [...legend.querySelectorAll(".legend-row")];
  const positionTooltip = (event) => {
    const bounds = chart.parentElement.getBoundingClientRect();
    const rawX = event?.clientX ? event.clientX - bounds.left : bounds.width / 2;
    const rawY = event?.clientY ? event.clientY - bounds.top - 12 : 36;
    tooltip.style.left = `${Math.max(62, Math.min(bounds.width - 62, rawX))}px`;
    tooltip.style.top = `${Math.max(38, Math.min(bounds.height - 12, rawY))}px`;
  };
  const activate = (index, event) => {
    const category = analysis.macros[index];
    if (!category) return;
    segments.forEach((segment, itemIndex) => {
      segment.classList.toggle("is-active", itemIndex === index);
      segment.classList.toggle("is-muted", itemIndex !== index);
    });
    rows.forEach((row, itemIndex) => {
      row.classList.toggle("is-active", itemIndex === index);
      row.classList.toggle("is-muted", itemIndex !== index);
    });
    const percent = analysis.total ? Math.round(category.minutes / analysis.total * 100) : 0;
    tooltip.innerHTML = `<strong>${escapeHTML(category.name)}</strong><span>${formatHours(category.minutes, true)} · ${percent}% do tempo</span>`;
    positionTooltip(event);
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
  };
  const clear = () => {
    segments.forEach((segment) => segment.classList.remove("is-active", "is-muted"));
    rows.forEach((row) => row.classList.remove("is-active", "is-muted"));
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  };

  segments.forEach((segment, index) => {
    segment.addEventListener("pointerenter", (event) => activate(index, event));
    segment.addEventListener("pointermove", positionTooltip);
    segment.addEventListener("pointerleave", clear);
    segment.addEventListener("focus", () => activate(index));
    segment.addEventListener("blur", clear);
  });
  rows.forEach((row, index) => {
    row.addEventListener("pointerenter", () => activate(index));
    row.addEventListener("pointerleave", clear);
    row.addEventListener("focus", () => activate(index));
    row.addEventListener("blur", clear);
  });
}

function renderCapacity(analysis) {
  const capacity = state.settings.weeklyCapacity * 60;
  const occupied = analysis.occupiedTotal;
  const free = Math.max(0, capacity - occupied);
  const ratio = capacity ? occupied / capacity : 0;
  $("#availableHours").textContent = formatHours(free, true);
  $("#capacityHours").textContent = formatHours(capacity);
  $("#usedHours").textContent = formatHours(occupied, true);
  $("#freeHours").textContent = formatHours(free, true);
  $("#capacityProgress").style.width = `${Math.min(100, ratio * 100)}%`;
  const status = $("#capacityStatus");
  status.className = "status-badge";
  if (ratio >= 1) {
    status.textContent = "Sem espaço";
    status.classList.add("danger");
  } else if (ratio > .85) {
    status.textContent = "Atenção";
    status.classList.add("warning");
  } else {
    status.textContent = "Saudável";
  }
  const callout = $("#capacityCallout");
  if (free <= 0) {
    callout.innerHTML = "Seus períodos de trabalho estão <strong>totalmente ocupados</strong> nesta semana.";
  } else if (free >= 4 * 60) {
    callout.innerHTML = `Você ainda tem <strong>${formatHours(free, true)} livres</strong>, somando os espaços vazios dos seus períodos de trabalho.`;
  } else {
    callout.innerHTML = `Sua margem está curta. Preserve as <strong>${formatHours(free, true)}</strong> restantes para urgências ou recuperação.`;
  }
}

function renderDaily(analysis) {
  const names = ["Seg", "Ter", "Qua", "Qui", "Sex"];
  const capacityPerDay = state.settings.weeklyCapacity * 60 / Math.max(1, state.settings.workdays.length);
  const occupiedDaily = analysis.occupiedDaily.slice(0, 5);
  const chartMax = Math.max(capacityPerDay, ...occupiedDaily, 60);
  const today = new Date();
  const currentWeek = startOfWeek(today).getTime() === weekBounds().start.getTime();
  $("#dailyChart").innerHTML = occupiedDaily.map((minutes, index) => {
    const calendarDay = index + 1;
    const isWorkday = state.settings.workdays.includes(calendarDay);
    const dayCapacity = isWorkday ? capacityPerDay : 0;
    const height = Math.min(100, minutes / chartMax * 100);
    const capacityHeight = Math.min(100, dayCapacity / chartMax * 100);
    const isToday = currentWeek && ((today.getDay() + 6) % 7 === index);
    const capacityState = !isWorkday ? "fora do horário configurado" : minutes > dayCapacity ? "acima da capacidade do dia" : "dentro da capacidade do dia";
    return `<div class="day-column" style="--height:${height}%;--delay:${index * 55}ms" tabindex="0" aria-label="${names[index]}: ${formatHours(minutes, true)}, ${capacityState}">
      <span class="day-value">${formatHours(minutes, true)}</span>
      <div class="day-bar-track" style="opacity:${isWorkday || minutes ? 1 : .45}">
        <div class="day-bar ${minutes > dayCapacity && dayCapacity ? "over" : ""}" style="--height:${height}%"></div>
        ${isWorkday ? `<span class="day-capacity-line" style="--capacity-height:${capacityHeight}%"></span>` : ""}
      </div>
      <span class="day-label ${isToday ? "today" : ""}">${names[index]}</span>
    </div>`;
  }).join("");
}

function renderInsights(analysis) {
  const unexpected = analysis.macros.find((item) => item.name === "Imprevistos")?.minutes || 0;
  const preparation = analysis.macros.find((item) => item.name === "Preparação")?.minutes || 0;
  const meetings = analysis.macros.find((item) => item.name === "Reuniões")?.minutes || 0;
  const unclassified = analysis.labels.find((item) => item.id === "unclassified")?.minutes || 0;
  const workweekDaily = analysis.occupiedDaily.slice(0, 5);
  const busiestIndex = workweekDaily.indexOf(Math.max(...workweekDaily));
  const dayNames = ["segunda", "terça", "quarta", "quinta", "sexta"];
  const insights = [];

  if (unexpected) insights.push({ emoji: "↗", color: "#d7643e", bg: "#fff0ea", text: `<strong>Imprevistos consumiram ${analysis.total ? Math.round(unexpected / analysis.total * 100) : 0}%</strong> do tempo registrado. Reserve uma margem para eles no próximo planejamento.` });
  if (meetings || preparation) insights.push({ emoji: "◷", color: "#418b65", bg: "#eaf4ed", text: `Reuniões e preparação somaram <strong>${formatHours(meetings + preparation, true)}</strong> nesta semana.` });
  if (workweekDaily[busiestIndex]) insights.push({ emoji: "⌁", color: "#4e80ba", bg: "#edf3fa", text: `Seu dia mais carregado foi <strong>${dayNames[busiestIndex]}</strong>, com ${formatHours(workweekDaily[busiestIndex], true)} ocupadas.` });
  if (unclassified) insights.push({ emoji: "!", color: "#9a772b", bg: "#fff7df", text: `<strong>${formatHours(unclassified, true)} ainda estão sem categoria.</strong> Classifique no Google Agenda para melhorar a leitura.` });
  if (!insights.length) insights.push({ emoji: "✓", color: "#418b65", bg: "#eaf4ed", text: "Adicione compromissos para começar a receber <strong>leituras automáticas</strong> da sua semana." });

  $("#insightList").innerHTML = insights.slice(0, 3).map((item) => `
    <div class="insight-item">
      <span class="insight-icon" style="--insight-color:${item.color};--insight-bg:${item.bg}">${item.emoji}</span>
      <p>${item.text}</p>
    </div>
  `).join("");
}

function renderLabels(analysis) {
  const max = analysis.labels[0]?.minutes || 1;
  const rows = analysis.labels.map((label, index) => `
    <div class="label-row ${index >= 6 && !state.labelsExpanded ? "hidden-row" : ""}">
      <div class="label-identity"><i class="label-swatch" style="background:${safeColor(label.color)}"></i><span>${escapeHTML(label.name)}</span></div>
      <div class="mini-track"><div class="mini-fill" style="width:${label.minutes / max * 100}%;background:${safeColor(label.color)}"></div></div>
      <div class="label-duration">${formatHours(label.minutes, true)}</div>
      <div class="label-share">${analysis.total ? Math.round(label.minutes / analysis.total * 100) : 0}%</div>
    </div>
  `).join("");
  $("#labelsTable").innerHTML = `
    <div class="label-row header"><span>Categoria</span><span>Proporção</span><span style="text-align:right">Tempo</span><span style="text-align:right">Total</span></div>
    ${rows || '<div class="empty-state">Nenhuma categoria encontrada.</div>'}
  `;
  const toggle = $("#toggleLabels");
  toggle.hidden = analysis.labels.length <= 6;
  toggle.textContent = state.labelsExpanded ? "Mostrar menos" : "Ver todas";
}

function renderEvents() {
  const events = state.events
    .filter((event) => eventMinutes(event) > 0)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  $("#eventCount").textContent = `${events.length} ${events.length === 1 ? "evento" : "eventos"}`;
  $("#eventList").innerHTML = events.length ? events.slice(0, 12).map((event) => {
    const label = getLabel(event.labelId);
    const start = new Date(event.start);
    const time = event.allDay ? "Dia inteiro" : start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return `<div class="event-row">
      <span class="event-day">${start.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")}</span>
      <i class="event-color" style="background:${safeColor(label.color)}"></i>
      <div class="event-info"><b>${escapeHTML(event.title || "Sem título")}</b><span>${time} · ${escapeHTML(label.name)}</span></div>
      <span class="event-duration">${formatHours(eventMinutes(event), true)}</span>
    </div>`;
  }).join("") : '<div class="empty-state">Nenhum compromisso nesta semana.</div>';
}

function renderSyncTime() {
  const time = state.lastSync instanceof Date ? state.lastSync : new Date(state.lastSync);
  $("#lastSync").textContent = state.connected
    ? `Sincronizado às ${time.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : "Conecte sua agenda para carregar os dados";
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function openModal(selector) {
  $(selector).hidden = false;
}

function closeModals() {
  $$(".modal-backdrop").forEach((modal) => { modal.hidden = true; });
}

function getManifestClientId() {
  return globalThis.chrome?.runtime?.getManifest?.().oauth2?.client_id || "";
}

function hasOAuthConfig() {
  const clientId = getManifestClientId();
  return clientId && !clientId.includes("COLOQUE_SEU_CLIENT_ID");
}

async function getAuthToken(interactive) {
  if (!globalThis.chrome?.identity) throw new Error("Abra o dashboard como uma extensão do Chrome para conectar sua conta.");
  const result = await chrome.identity.getAuthToken({ interactive });
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw new Error("O Google não retornou um token de acesso.");
  return token;
}

async function googleFetch(path, token) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 && globalThis.chrome?.identity) {
    await chrome.identity.removeCachedAuthToken({ token });
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Erro ${response.status} ao consultar o Google Agenda.`);
  return data;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function detectScheduleFromCalendar() {
  if (!state.connected) {
    showToast("Conecte o Google Agenda antes de buscar uma sugestão.", true);
    return;
  }
  const button = $("#detectScheduleButton");
  const hint = $("#scheduleHint");
  button.disabled = true;
  button.lastChild.textContent = " Analisando…";
  hint.classList.remove("success");
  hint.textContent = "Analisando seus compromissos das últimas 8 semanas…";
  try {
    const token = await getAuthToken(false);
    const end = new Date();
    const start = new Date(end.getTime() - 56 * DAY);
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "2500",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    });
    const data = await googleFetch(`calendars/primary/events?${params}`, token);
    const datesByWeekday = Array.from({ length: 7 }, () => new Set());
    const rangesByDate = new Map();

    (data.items || []).forEach((event) => {
      if (event.status === "cancelled" || isDeclinedEvent(event) || event.eventType === "birthday" || event.eventType === "outOfOffice") return;
      const rawStart = event.start?.dateTime || event.start?.date;
      if (!rawStart) return;
      const eventStart = new Date(event.start?.dateTime || `${event.start.date}T12:00:00`);
      const day = eventStart.getDay();
      const dateKey = `${eventStart.getFullYear()}-${eventStart.getMonth()}-${eventStart.getDate()}`;
      datesByWeekday[day].add(dateKey);
      if (!event.start?.dateTime || !event.end?.dateTime) return;
      const eventEnd = new Date(event.end.dateTime);
      if (eventEnd - eventStart <= 0 || eventEnd - eventStart > 12 * 60 * MINUTE) return;
      const startMinute = eventStart.getHours() * 60 + eventStart.getMinutes();
      const endMinute = eventEnd.getHours() * 60 + eventEnd.getMinutes();
      const current = rangesByDate.get(dateKey) || { day, start: startMinute, end: endMinute };
      current.start = Math.min(current.start, startMinute);
      current.end = Math.max(current.end, endMinute);
      rangesByDate.set(dateKey, current);
    });

    let suggestedDays = datesByWeekday
      .map((dates, day) => ({ day, count: dates.size }))
      .filter(({ count }) => count >= 3)
      .map(({ day }) => day);
    if (!suggestedDays.length) {
      suggestedDays = datesByWeekday.map((dates, day) => ({ day, count: dates.size })).filter(({ count }) => count > 0).map(({ day }) => day);
    }
    if (!suggestedDays.length) throw new Error("Não encontrei eventos suficientes para sugerir sua jornada.");

    const ranges = [...rangesByDate.values()].filter((range) => suggestedDays.includes(range.day));
    const configuredPeriods = state.settings.workPeriods;
    const suggestedStart = ranges.length
      ? Math.max(5 * 60, Math.floor((median(ranges.map((range) => range.start)) - 30) / 30) * 30)
      : timeToMinutes(configuredPeriods[0].start);
    const suggestedEnd = ranges.length
      ? Math.min(23 * 60, Math.ceil((median(ranges.map((range) => range.end)) + 30) / 30) * 30)
      : timeToMinutes(configuredPeriods[1].end);
    const firstPeriodEnd = timeToMinutes($("#period1End").value);
    const secondPeriodStart = timeToMinutes($("#period2Start").value);

    $$("#weekdayPicker input").forEach((input) => { input.checked = suggestedDays.includes(Number(input.value)); });
    $("#period1Start").value = minutesToTime(Math.min(suggestedStart, firstPeriodEnd - 30));
    $("#period2End").value = minutesToTime(Math.max(suggestedEnd, secondPeriodStart + 30));
    updateCapacityPreview();
    hint.textContent = "Sugestão aplicada. Seu intervalo entre os períodos foi mantido.";
    hint.classList.add("success");
  } catch (error) {
    hint.textContent = error.message || "Não foi possível analisar sua agenda.";
    showToast(hint.textContent, true);
  } finally {
    button.disabled = false;
    button.lastChild.textContent = " Sugerir";
  }
}

async function syncGoogle({ interactive = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  $("#syncButton").classList.add("loading");
  try {
    const token = await getAuthToken(interactive);
    const { start, end } = weekBounds();
    const commonParams = new URLSearchParams({ eventLabelVersion: "1" });
    const eventParams = new URLSearchParams({
      eventLabelVersion: "1",
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "2500",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    });
    const [calendar, eventData] = await Promise.all([
      googleFetch(`calendars/primary?${commonParams}`, token),
      googleFetch(`calendars/primary/events?${eventParams}`, token),
    ]);
    const apiLabels = calendar.labelProperties?.eventLabels || [];
    state.labels = apiLabels.map((label) => ({
      id: label.id,
      name: label.name || "Label sem nome",
      color: safeColor(label.backgroundColor),
    }));
    state.events = (eventData.items || [])
      .filter((event) => event.status !== "cancelled" && !isDeclinedEvent(event))
      .map(mapGoogleEvent);
    state.comparison = null;
    state.connected = true;
    state.source = "google";
    state.lastSync = new Date();
    await storageSet({ connected: true, googleCache: {
      weekStart: start.toISOString(), labels: state.labels, events: state.events, lastSync: state.lastSync.toISOString(),
    }});
    render();
    if (state.activeView === "comparison") loadComparison({ force: true });
    showToast("Google Agenda sincronizado com sucesso.");
  } catch (error) {
    console.error(error);
    if (interactive) {
      showToast(error.message || "Não foi possível conectar ao Google Agenda.", true);
    } else {
      useDisconnectedData();
      showToast("Sua sessão do Google precisa ser renovada.", true);
    }
  } finally {
    state.syncing = false;
    $("#syncButton").classList.remove("loading");
  }
}

async function connectGoogle() {
  if (state.connected) {
    const shouldDisconnect = confirm("Deseja desconectar o Google Agenda?");
    if (!shouldDisconnect) return;
    try {
      if (globalThis.chrome?.identity) await chrome.identity.clearAllCachedAuthTokens();
    } catch (error) {
      console.warn(error);
    }
    await storageSet({ connected: false, googleCache: null });
    useDisconnectedData();
    showToast("Google Agenda desconectado.");
    return;
  }
  if (!hasOAuthConfig()) {
    openModal("#setupModal");
    return;
  }
  await syncGoogle({ interactive: true });
}

function useDisconnectedData(renderNow = true) {
  state.connected = false;
  state.source = "disconnected";
  state.labels = [];
  state.events = [];
  state.lastSync = new Date();
  if (renderNow) {
    render();
    if (state.activeView === "comparison") loadComparison();
  }
}

async function changeWeek(direction) {
  state.weekOffset += direction;
  state.comparison = null;
  if (state.connected) await syncGoogle();
  else {
    render();
    if (state.activeView === "comparison") loadComparison();
  }
}

function switchView(view) {
  state.activeView = view === "comparison" ? "comparison" : "overview";
  $("#overviewView").hidden = state.activeView !== "overview";
  $("#comparisonView").hidden = state.activeView !== "comparison";
  $$(".nav-item[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === state.activeView));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (state.activeView === "comparison") loadComparison();
}

function openSettings() {
  const [firstPeriod, secondPeriod] = state.settings.workPeriods;
  $("#period1Start").value = firstPeriod.start;
  $("#period1End").value = firstPeriod.end;
  $("#period2Start").value = secondPeriod.start;
  $("#period2End").value = secondPeriod.end;
  $("#ignoreAllDay").checked = state.settings.ignoreAllDay;
  $$("#weekdayPicker input").forEach((input) => {
    input.checked = state.settings.workdays.includes(Number(input.value));
  });
  $("#scheduleHint").textContent = "Você poderá revisar tudo antes de salvar.";
  $("#scheduleHint").classList.remove("success");
  updateCapacityPreview();
  openModal("#settingsModal");
}

async function saveSettings(event) {
  event.preventDefault();
  const workdays = $$("#weekdayPicker input:checked").map((input) => Number(input.value));
  if (!workdays.length) {
    showToast("Selecione pelo menos um dia de trabalho.", true);
    return;
  }
  const workPeriods = getWorkPeriodsFromForm();
  if (workPeriods.some((period) => timeToMinutes(period.end) <= timeToMinutes(period.start))) {
    showToast("O término de cada período precisa ser posterior ao início.", true);
    return;
  }
  if (timeToMinutes(workPeriods[1].start) < timeToMinutes(workPeriods[0].end)) {
    showToast("O segundo período não pode começar antes do término do primeiro.", true);
    return;
  }
  const weeklyCapacity = calculateWeeklyCapacity(workdays, workPeriods);
  if (weeklyCapacity <= 0) {
    showToast("Configure pelo menos um período válido de trabalho.", true);
    return;
  }
  state.settings = {
    weeklyCapacity,
    workPeriods,
    ignoreAllDay: $("#ignoreAllDay").checked,
    workdays,
  };
  await storageSet({ settings: state.settings });
  closeModals();
  render();
  showToast("Preferências atualizadas.");
}

function bindEvents() {
  $("#previousWeek").addEventListener("click", () => changeWeek(-1));
  $("#nextWeek").addEventListener("click", () => changeWeek(1));
  $("#comparisonPreviousWeek").addEventListener("click", () => changeWeek(-1));
  $("#comparisonNextWeek").addEventListener("click", () => changeWeek(1));
  $("#todayButton").addEventListener("click", async () => {
    state.weekOffset = 0;
    state.comparison = null;
    if (state.connected) await syncGoogle();
    else render();
  });
  $("#comparisonTodayButton").addEventListener("click", async () => {
    state.weekOffset = 0;
    state.comparison = null;
    if (state.connected) await syncGoogle();
    else {
      render();
      loadComparison();
    }
  });
  $("#connectButton").addEventListener("click", connectGoogle);
  $("#syncButton").addEventListener("click", async () => {
    if (state.connected) await syncGoogle();
    else connectGoogle();
  });
  $("#settingsButton").addEventListener("click", openSettings);
  $("#adjustWorkHours").addEventListener("click", openSettings);
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#detectScheduleButton").addEventListener("click", detectScheduleFromCalendar);
  $$("#weekdayPicker input, #period1Start, #period1End, #period2Start, #period2End").forEach((input) => input.addEventListener("change", updateCapacityPreview));
  $("#toggleLabels").addEventListener("click", () => { state.labelsExpanded = !state.labelsExpanded; renderLabels(analyze()); });
  $$('[data-close-modal]').forEach((button) => button.addEventListener("click", closeModals));
  $$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModals();
  }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModals(); });
  $$(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => {
    switchView(button.dataset.view);
  }));
  $("#comparisonAction").addEventListener("click", () => {
    if ($("#comparisonAction").dataset.action === "retry") loadComparison({ force: true });
    else openSettings();
  });
}

async function init() {
  bindEvents();
  const stored = await storageGet(["settings", "connected", "googleCache"]);
  state.settings = normalizeSettings(stored.settings || {});
  await storageSet({ settings: state.settings });
  useDisconnectedData(false);

  const currentStart = weekBounds().start.toISOString();
  if (stored.connected && stored.googleCache?.weekStart === currentStart) {
    state.connected = true;
    state.source = "google";
    state.labels = stored.googleCache.labels || [];
    state.events = (stored.googleCache.events || []).map((event) => ({ ...event, start: new Date(event.start), end: new Date(event.end) }));
    state.lastSync = new Date(stored.googleCache.lastSync);
  }
  render();
  if (stored.connected) syncGoogle({ interactive: false });
  const query = new URLSearchParams(location.search);
  if (query.has("welcome")) showToast("Bem-vindo ao Ritmo. Conecte sua agenda para começar.");
  if (query.has("settings")) openSettings();
  if (query.get("view") === "comparison") switchView("comparison");
}

init();
