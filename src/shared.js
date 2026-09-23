// Helpers shared by the background worker, the popup and the blocked page.

// readyAt: when the wait to turn blocking off ends (a timestamp), or null if
//   no wait is running. Blocking stays on until then.
// readyUntil: when the chance to turn blocking off lapses, or null if it isn't
//   on offer. Blocking is still on; the person turns it off, or doesn't.
// enableAt: when blocking turns back on, or null while it's on.
// removeAt: when each site that's being removed leaves the list, by site.
export const DEFAULT_SETTINGS = {
  enabled: true,
  sites: [],
  readyAt: null,
  readyUntil: null,
  enableAt: null,
  removeAt: {},
};

// Turning blocking off and removing a blocked site only happen after this
// wait, so there's time for the urge to visit the site to pass.
export const UNBLOCK_DELAY_MS = 5 * 60 * 1000;

// Once the wait is over, the chance to turn blocking off lasts this long: long
// enough to come back from an interruption, short enough that a wait can't be
// banked for later in the day.
export const READY_WINDOW_MS = 15 * 60 * 1000;

// Once blocking turns off, it turns itself back on after this long.
export const REENABLE_DELAY_MS = 3 * 60 * 1000;

export function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

// The background worker makes delayed changes when an alarm goes off, but
// Chrome can run alarms late: its timers stop while the computer sleeps. Pages
// showing a countdown call this once it has run out, so the change happens on
// time instead of whenever the alarm fires.
export function requestOverdueChanges() {
  return chrome.runtime.sendMessage("finish-overdue-changes").catch(() => {});
}

export function blockedPageUrl(originalUrl) {
  return `${chrome.runtime.getURL("src/blocked.html")}#${originalUrl}`;
}

// "3 minutes" for 180000. Status text uses this so it tracks the constants.
export function minutesLabel(ms) {
  const minutes = Math.round(ms / 60000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// A "4:59"-style countdown to `until`, kept current by updateCountdowns().
export function countdown(until) {
  const time = document.createElement("span");
  time.className = "countdown";
  time.dataset.until = until;
  time.textContent = timeLeft(until);
  return time;
}

function timeLeft(until) {
  const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Refreshes every countdown on the page. Once one has run out, asks the worker
// to make the change it was counting down to (see requestOverdueChanges).
export function updateCountdowns() {
  let overdue = false;
  for (const time of document.querySelectorAll(".countdown")) {
    const until = Number(time.dataset.until);
    time.textContent = timeLeft(until);
    if (until <= Date.now()) overdue = true;
  }
  if (overdue) requestOverdueChanges();
}

// Turns user input like "https://www.YouTube.com/watch?v=1" into "youtube.com".
// Returns null if the input doesn't look like a website.
export function normalizeSite(input) {
  let text = String(input).trim().toLowerCase().replace(/^\*\./, "");
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;

  let host;
  try {
    host = new URL(text).hostname;
  } catch {
    return null;
  }

  host = host.replace(/\.$/, "").replace(/^www\./, "");
  const isHostname = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host);
  const looksLikeSite = host.includes(".") || host === "localhost";
  return isHostname && looksLikeSite ? host : null;
}

// Returns the entry in `sites` that blocks `hostname` (the site itself or a
// parent domain, so "youtube.com" also blocks "m.youtube.com"), or undefined.
export function blockedBy(hostname, sites) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return sites.find((site) => host === site || host.endsWith(`.${site}`));
}
