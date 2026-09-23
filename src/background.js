import {
  READY_WINDOW_MS,
  REENABLE_DELAY_MS,
  blockedBy,
  blockedPageUrl,
  loadSettings,
  minutesLabel,
} from "./shared.js";

const RULE_ID = 1;
const ALARM = "delayed-changes";
const HEARTBEAT = "delayed-changes-backstop";
const READY_NOTIFICATION = "ready";

// Mirrors the saved settings into a single declarativeNetRequest rule, so
// Chrome redirects blocked sites to the blocked page before they load.
async function applySettings() {
  const settings = await loadSettings();
  // Saving new settings runs this again (see storage.onChanged below).
  if (await finishDelayedChanges(settings)) return;

  const { enabled, sites, readyUntil } = settings;
  const active = enabled && sites.length > 0;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: active
      ? [
          {
            id: RULE_ID,
            action: {
              type: "redirect",
              // \0 is the full original URL, passed along so the blocked page can show it.
              redirect: { regexSubstitution: blockedPageUrl("\\0") },
            },
            condition: {
              regexFilter: "^.+$",
              requestDomains: sites,
              resourceTypes: ["main_frame", "sub_frame"],
            },
          },
        ]
      : [],
  });

  await updateIcon(enabled);

  // The notification that announced the offer has nothing to say once the
  // offer has been taken or has lapsed.
  if (!readyUntil) clearReadyNotification();

  // Tabs that were already open on a blocked site get blocked right away.
  if (active) {
    const tabs = await chrome.tabs.query({
      url: ["http://*/*", "https://*/*"],
    });
    for (const tab of tabs) blockTabIfNeeded(tab.id, tab.url, sites);
  }

  // Now that the rule is current, open blocked pages can safely continue to
  // sites that are no longer blocked. (Fails harmlessly if none are open.)
  chrome.runtime.sendMessage("settings-applied").catch(() => {});
}

// Carries out the delayed changes (ending the wait, withdrawing the offer,
// turning blocking back on, removing sites) whose time has come and returns
// true if it saved any. Either way, it leaves an alarm armed for the next
// change that's due.
async function finishDelayedChanges(settings) {
  const now = Date.now();
  const changes = {};
  let { enabled, sites, readyAt, readyUntil, enableAt, removeAt } = settings;

  // The wait is over: blocking can be turned off, for a while. The offer runs
  // from when the wait was due to end, not from when this ran, so an alarm that
  // fires late or a Chrome restart hours later can't hand out a fresh offer. If
  // it has already lapsed, the check below withdraws it in this same pass.
  let offerOpened = false;
  if (readyAt && readyAt <= now) {
    readyUntil = changes.readyUntil = readyAt + READY_WINDOW_MS;
    readyAt = changes.readyAt = null;
    offerOpened = readyUntil > now;
  }

  // An offer nobody took. Blocking simply stays on.
  if (readyUntil && readyUntil <= now) {
    readyUntil = changes.readyUntil = null;
  }

  // Blocking never stays off for long. The popup and the blocked page set
  // enableAt when they turn blocking off; this also catches blocking that was
  // turned off some other way.
  if (!enabled && !enableAt) {
    enableAt = changes.enableAt = now + REENABLE_DELAY_MS;
  } else if (!enabled && enableAt <= now) {
    enabled = changes.enabled = true;
    enableAt = changes.enableAt = null;
  }

  // Once blocking is off, removing a site no longer needs to wait.
  const removed = Object.keys(removeAt).filter(
    (site) => !enabled || removeAt[site] <= now,
  );
  if (removed.length > 0) {
    sites = changes.sites = sites.filter((site) => !removed.includes(site));
    removeAt = changes.removeAt = Object.fromEntries(
      Object.entries(removeAt).filter(([site]) => !removed.includes(site)),
    );
  }

  // Arm the alarm on every pass, including one that saves changes. The alarm
  // that woke this worker is spent, and saving only queues another pass by way
  // of storage.onChanged, which Chrome can stop the worker before it runs.
  // Leaving the alarm to that pass is what stranded blocking in the off state:
  // the moment blocking turned off was the one moment nothing got armed.
  await syncAlarms(
    deadlines({ enabled, readyAt, readyUntil, enableAt, removeAt }),
  );

  if (Object.keys(changes).length > 0) {
    await chrome.storage.local.set(changes);
    // Only once the change is safely saved: nothing about telling the person
    // may hold up the state machine (see notifyReady).
    if (offerOpened) notifyReady();
    return true;
  }
  return false;
}

// When each pending delayed change is due.
function deadlines({ enabled, readyAt, readyUntil, enableAt, removeAt }) {
  return [
    readyAt,
    readyUntil,
    !enabled && enableAt,
    ...Object.values(removeAt),
  ].filter(Boolean);
}

function overdue(settings) {
  const now = Date.now();
  return deadlines(settings).some((at) => at <= now);
}

// Wakes this worker when the next delayed change is due. The repeating alarm is
// a backstop: a single one-shot alarm is one missed wake-up away from leaving
// blocking off indefinitely, and it costs one wake-up a minute only while a
// change is actually pending.
async function syncAlarms(deadlines) {
  const next = Math.min(...deadlines);
  const pending = next !== Infinity;

  if (pending) await chrome.alarms.create(ALARM, { when: next });
  else await chrome.alarms.clear(ALARM);

  // Re-creating a periodic alarm restarts its period, so only touch it when it
  // needs to start or stop.
  const beating = Boolean(await chrome.alarms.get(HEARTBEAT));
  if (pending && !beating)
    await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 });
  else if (!pending && beating) await chrome.alarms.clear(HEARTBEAT);
}

// A delayed change must not run late because a wake-up ran late or went
// missing (see requestOverdueChanges). Blocking staying off past enableAt is
// the case that matters most.
async function finishIfOverdue() {
  if (overdue(await loadSettings())) scheduleApply();
}

// The wait is over, but the person who started it may well have moved on to
// something else by now. Best effort only: chrome.notifications is missing
// until the extension is reloaded with the permission in its manifest, and a
// notification that fails must never leave the wait stuck at 0:00.
async function notifyReady() {
  try {
    await chrome.notifications?.create(READY_NOTIFICATION, {
      type: "basic",
      iconUrl: "/icons/on-128.png",
      title: "You can turn blocking off now",
      message:
        `Flip the switch, or use the button on a blocked page, for ` +
        `${minutesLabel(REENABLE_DELAY_MS)} off. ` +
        `The offer ends in ${minutesLabel(READY_WINDOW_MS)}.`,
    });
  } catch (error) {
    console.error(error);
  }
}

async function clearReadyNotification() {
  try {
    await chrome.notifications?.clear(READY_NOTIFICATION);
  } catch {
    // Nothing to clear, or no notifications API. Either way, nothing to do.
  }
}

function blockTabIfNeeded(tabId, url, sites) {
  if (!url || !/^https?:/.test(url)) return;
  if (blockedBy(new URL(url).hostname, sites)) {
    chrome.tabs.update(tabId, { url: blockedPageUrl(url) });
  }
}

function updateIcon(enabled) {
  const state = enabled ? "on" : "off";
  const path = {};
  for (const size of [16, 32, 48, 128])
    path[size] = `/icons/${state}-${size}.png`;
  return Promise.all([
    chrome.action.setIcon({ path }),
    chrome.action.setTitle({ title: `Site Blocker (${state})` }),
  ]);
}

// Earlier versions saved the end of the wait as disableAt, and turned blocking
// off at that moment instead of offering to.
async function migrateSettings() {
  const { disableAt } = await chrome.storage.local.get("disableAt");
  if (disableAt === undefined) return;
  if (disableAt) await chrome.storage.local.set({ readyAt: disableAt });
  await chrome.storage.local.remove("disableAt");
}

// Settings can change in quick succession; apply them one at a time.
let queue = Promise.resolve();
function scheduleApply() {
  queue = queue.then(applySettings).catch(console.error);
}

chrome.runtime.onInstalled.addListener(() => {
  queue = queue.then(migrateSettings).catch(console.error);
  scheduleApply();
});
chrome.runtime.onStartup.addListener(scheduleApply);
chrome.alarms.onAlarm.addListener(scheduleApply);
chrome.runtime.onMessage.addListener((message) => {
  if (message === "finish-overdue-changes") scheduleApply();
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") scheduleApply();
});

// Safety net for pages shown without a network request (e.g. restored from
// the back/forward cache), which the rule above never sees.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Reloading a page leaves the URL unchanged, so changeInfo carries no url at
  // all: watch for the load itself as well, or a reload slips through.
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  const settings = await loadSettings();
  if (settings.enabled) blockTabIfNeeded(tabId, tab.url, settings.sites);
  if (overdue(settings)) scheduleApply();
});

// Two more chances to notice a missed wake-up, both free: these fire on the
// things a person does constantly while waiting for blocking to come back.
chrome.tabs.onActivated.addListener(finishIfOverdue);
chrome.windows.onFocusChanged.addListener(finishIfOverdue);
