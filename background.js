chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html?welcome=1") });
  }
});

function getAuthToken(interactive) {
  return chrome.identity.getAuthToken({ interactive }).then((result) => {
    const token = typeof result === "string" ? result : result?.token;
    if (!token) throw new Error("O Google não retornou um token de acesso.");
    return token;
  });
}

async function googleFetch(path, token) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) await chrome.identity.removeCachedAuthToken({ token });
    throw new Error(data?.error?.message || "Não foi possível consultar o Google Agenda.");
  }
  return data;
}

function ownResponseStatus(event) {
  return event.attendees?.find((attendee) => attendee.self)?.responseStatus || "";
}

function isDeclinedEvent(event) {
  return ownResponseStatus(event) === "declined";
}

async function syncCalendar({ timeMin, timeMax, interactive }) {
  const token = await getAuthToken(Boolean(interactive));
  const labelParams = new URLSearchParams({ eventLabelVersion: "1" });
  const eventParams = new URLSearchParams({
    eventLabelVersion: "1",
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: "2500",
    timeMin,
    timeMax,
  });
  const [calendar, eventData] = await Promise.all([
    googleFetch(`calendars/primary?${labelParams}`, token),
    googleFetch(`calendars/primary/events?${eventParams}`, token),
  ]);
  const labels = (calendar.labelProperties?.eventLabels || []).map((label) => ({
    id: label.id,
    name: label.name || "Label sem nome",
    color: /^#[0-9a-f]{6}$/i.test(label.backgroundColor || "") ? label.backgroundColor : "#9aa0a6",
  }));
  const events = (eventData.items || [])
    .filter((event) => event.status !== "cancelled" && !isDeclinedEvent(event))
    .map((event) => ({
      id: event.id,
      title: event.summary || "Sem título",
      start: event.start?.dateTime || `${event.start?.date}T00:00:00`,
      end: event.end?.dateTime || `${event.end?.date}T00:00:00`,
      allDay: Boolean(event.start?.date),
      labelId: event.eventLabelId || "unclassified",
      htmlLink: event.htmlLink || "",
      responseStatus: ownResponseStatus(event),
      transparency: event.transparency || "opaque",
    }));
  const cache = { weekStart: timeMin, labels, events, lastSync: new Date().toISOString() };
  await chrome.storage.local.set({ connected: true, googleCache: cache });
  return cache;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SYNC_CALENDAR") return false;
  syncCalendar(message.payload)
    .then((cache) => sendResponse({ ok: true, cache }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
