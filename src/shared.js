// Helpers shared by the background worker, the popup and the blocked page.

// enabled: whether blocking is on. It only turns off for a break.
// enableAt: when the current break ends, or null while blocking is on.
// removeAt: when each site that's being removed leaves the list, by site.
// earned: all the break time ever earned by focusing. Only the background
//   worker changes it (see countFocus there).
// spent: all the break time ever taken. Only the popup and the blocked page
//   change it. Keeping the two apart means neither side can overwrite an update
//   the other just made; what's saved is the difference (see savedBreak).
// focusSince: when the focus time that hasn't been counted yet began, or null
//   while the focus clock is stopped: blocking is off, or nobody's at the
//   computer. Only the background worker changes it.
// focusUntil: when the focus clock stops earning, because by then the most
//   break time that can be saved up will be. Set along with focusSince.
// reason: what the latest borrowed break was for and when it ends, as
//   { text, until }, or null if the latest break wasn't borrowed.
export const DEFAULT_SETTINGS = {
  enabled: true,
  sites: [],
  enableAt: null,
  removeAt: {},
  earned: 0,
  spent: 0,
  focusSince: null,
  focusUntil: null,
  reason: null,
};

// Focus earns breaks: a minute of break for every FOCUS_PER_BREAK minutes that
// blocking is on while you're at the computer.
export const FOCUS_PER_BREAK = 6;

// The most break time that can be saved up, so that a morning of focus can't
// pay for an afternoon off.
export const MAX_SAVED_MS = 10 * 60 * 1000;

// A break shorter than this isn't worth taking. Until this much is saved, the
// only way to a blocked site is to borrow time.
const MIN_BREAK_MS = 60 * 1000;

// How long a borrowed break can last. Borrowed time is paid back with focus
// before the next break, and no more than MAX_BORROWED_MS can be owed at once.
const BORROW_OPTIONS_MS = [2, 5, 10].map((minutes) => minutes * 60000);
const MAX_BORROWED_MS = 15 * 60 * 1000;

// Removing a blocked site only happens after this wait, so there's time for the
// urge to visit the site to pass.
export const REMOVE_DELAY_MS = 5 * 60 * 1000;

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

// Break time saved up, including what the focus since focusSince has earned.
// Negative while borrowed time is being paid back.
export function savedBreak(settings, now = Date.now()) {
  return settings.earned - settings.spent + uncountedBreak(settings, now);
}

// The break earned by the focus the background worker hasn't counted yet.
// Nothing counts focus as it adds up: everything that shows or spends break
// time works it out from focusSince.
export function uncountedBreak({ focusSince, focusUntil }, now = Date.now()) {
  if (!focusSince) return 0;
  const focus = Math.max(0, Math.min(now, focusUntil) - focusSince);
  // Whole milliseconds keep the totals exact, so a full bank doesn't show as a
  // minute short.
  return Math.round(focus / FOCUS_PER_BREAK);
}

// Goes up by one for each minute of focus. Nothing a page shows about breaks
// changes in between, so pages re-render when this does.
export function focusMinutes(settings) {
  return Math.floor((savedBreak(settings) * FOCUS_PER_BREAK) / 60000);
}

export function canTakeBreak(settings) {
  const { enabled, sites } = settings;
  return enabled && sites.length > 0 && savedBreak(settings) >= MIN_BREAK_MS;
}

// How much focus it takes before the next break can be taken.
export function focusUntilBreak(settings) {
  return Math.max(0, MIN_BREAK_MS - savedBreak(settings)) * FOCUS_PER_BREAK;
}

// The lengths a break can be borrowed for right now: none while there's a
// break saved to take instead, and none that would owe more than
// MAX_BORROWED_MS.
export function borrowOptions(settings) {
  const saved = savedBreak(settings);
  if (saved >= MIN_BREAK_MS) return [];
  return BORROW_OPTIONS_MS.filter((ms) => saved - ms >= -MAX_BORROWED_MS);
}

// The settings changes for each way a break starts and ends. Starting one
// spends its whole length up front; ending it early gives back what's left.
export function takeBreak(settings) {
  return startBreak(settings, savedBreak(settings), null);
}

export function borrowBreak(settings, ms, reason) {
  return startBreak(settings, ms, reason);
}

function startBreak(settings, ms, reason) {
  const until = Date.now() + ms;
  return {
    enabled: false,
    enableAt: until,
    spent: settings.spent + ms,
    reason: reason ? { text: reason, until } : null,
  };
}

export function endBreak(settings) {
  const left = Math.max(0, (settings.enableAt ?? 0) - Date.now());
  return {
    enabled: true,
    enableAt: null,
    spent: settings.spent - left,
    reason: null,
  };
}

export function blockedPageUrl(originalUrl) {
  return `${chrome.runtime.getURL("src/blocked.html")}#${originalUrl}`;
}

// "3 minutes" for 180000. Status text uses this so it tracks the constants.
// Pass Math.floor or Math.ceil to round the other way.
export function minutesLabel(ms, round = Math.round) {
  const minutes = round(ms / 60000);
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
