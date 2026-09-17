import {
  REENABLE_DELAY_MS,
  blockedBy,
  blockedPageUrl,
  loadSettings,
} from "./shared.js";

const RULE_ID = 1;
const ALARM = "delayed-changes";

// Mirrors the saved settings into a single declarativeNetRequest rule, so
// Chrome redirects blocked sites to the blocked page before they load.
async function applySettings() {
  const settings = await loadSettings();
  // Saving new settings runs this again (see storage.onChanged below).
  if (await finishDelayedChanges(settings)) return;

  const { enabled, sites } = settings;
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

// Carries out the delayed changes (turning blocking off and back on, removing
// sites) whose time has come and returns true if it saved any. Otherwise sets
// an alarm to wake this worker when the next one is due.
async function finishDelayedChanges({
  enabled,
  sites,
  disableAt,
  enableAt,
  removeAt,
}) {
  const now = Date.now();
  const changes = {};

  if (disableAt && disableAt <= now) {
    enabled = changes.enabled = false;
    changes.disableAt = null;
    enableAt = null;
  }

  // Blocking never stays off for long. The time off counts from when blocking
  // actually turned off, which can be after disableAt if the alarm ran late.
  // This also catches blocking that was turned off before this rule existed.
  if (!enabled && !enableAt) {
    changes.enableAt = now + REENABLE_DELAY_MS;
  } else if (!enabled && enableAt <= now) {
    enabled = changes.enabled = true;
    changes.enableAt = null;
  }

  // Once blocking is off, removing a site no longer needs to wait.
  const removed = Object.keys(removeAt).filter(
    (site) => !enabled || removeAt[site] <= now,
  );
  if (removed.length > 0) {
    changes.sites = sites.filter((site) => !removed.includes(site));
    changes.removeAt = Object.fromEntries(
      Object.entries(removeAt).filter(([site]) => !removed.includes(site)),
    );
  }

  if (Object.keys(changes).length > 0) {
    await chrome.storage.local.set(changes);
    return true;
  }

  const pending = [disableAt, !enabled && enableAt, ...Object.values(removeAt)];
  const next = Math.min(...pending.filter(Boolean));
  if (next === Infinity) await chrome.alarms.clear(ALARM);
  else await chrome.alarms.create(ALARM, { when: next });
  return false;
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

// Settings can change in quick succession; apply them one at a time.
let queue = Promise.resolve();
function scheduleApply() {
  queue = queue.then(applySettings).catch(console.error);
}

chrome.runtime.onInstalled.addListener(scheduleApply);
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
chrome.tabs.onUpdated.addListener(async (tabId, { url }) => {
  if (!url) return;
  const { enabled, enableAt, sites } = await loadSettings();
  if (enabled) blockTabIfNeeded(tabId, url, sites);
  // The alarm that turns blocking back on can run late (see
  // requestOverdueChanges), so don't let browsing go on past enableAt.
  else if (enableAt && enableAt <= Date.now()) scheduleApply();
});
