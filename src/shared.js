// Helpers shared by the background worker, the popup and the blocked page.

// disableAt: when blocking turns off (a timestamp), or null if it isn't turning off.
// enableAt: when blocking turns back on, or null while it's on.
// removeAt: when each site that's being removed leaves the list, by site.
export const DEFAULT_SETTINGS = {
  enabled: true,
  sites: [],
  disableAt: null,
  enableAt: null,
  removeAt: {},
};

// Turning blocking off and removing a blocked site only happen after this
// wait, so there's time for the urge to visit the site to pass.
export const UNBLOCK_DELAY_MS = 5 * 60 * 1000;

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
