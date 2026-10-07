import {
  FOCUS_PER_BREAK,
  MAX_SAVED_MS,
  blockedBy,
  blockedPageUrl,
  loadSettings,
  uncountedBreak,
} from "./shared.js";

const RULE_ID = 1;
const ALARM = "delayed-changes";
const HEARTBEAT = "heartbeat";

// This long without keyboard or mouse input, in any app, means whoever was at
// the computer has stepped away.
const IDLE_AFTER_SECONDS = 5 * 60;

// While Chrome is in use, the focus time so far is counted this often at most
// (see countFocusSoFar).
const COUNT_EVERY_MS = 60 * 1000;

// Only the focus count writes these, and blocking doesn't depend on them.
const FOCUS_COUNT_KEYS = ["earned", "focusSince", "focusUntil"];

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

// Carries out the delayed changes (ending a break, removing sites) whose time
// has come, and starts or stops the focus clock to match. Returns true if it
// saved a change that runs this pass again. Either way, it leaves an alarm
// armed for the next change that's due.
async function finishDelayedChanges(settings) {
  const now = Date.now();
  const changes = {};
  let { enabled, sites, enableAt, removeAt, focusSince } = settings;

  // The break is over. Every break has an end: this also catches blocking that
  // was turned off some other way, and turns it straight back on.
  if (!enabled && !(enableAt > now)) {
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

  // Focus time counts from the moment blocking is on, and not a moment after
  // it turns off: the time on a break never counts. Stopping the clock counts
  // the time up to now. Blocking can also come on while nobody's at the
  // computer, and then the clock waits for them (see the idle listener).
  const focusing = enabled && sites.length > 0;
  if (!focusing && focusSince) {
    Object.assign(changes, countFocus(settings, now, false));
  } else if (focusing && !focusSince && (await atComputer())) {
    Object.assign(changes, startFocusClock(settings, now));
  }

  // Arm the alarm on every pass, including one that saves changes. The alarm
  // that woke this worker is spent, and saving only queues another pass by way
  // of storage.onChanged, which Chrome can stop the worker before it runs.
  await syncAlarms(deadlines({ enabled, enableAt, removeAt }));

  if (Object.keys(changes).length === 0) return false;
  await chrome.storage.local.set(changes);
  // Saving the focus count alone doesn't queue another pass (see
  // storage.onChanged).
  return !onlyFocusCount(changes);
}

// When each pending delayed change is due.
function deadlines({ enabled, enableAt, removeAt }) {
  return [!enabled && enableAt, ...Object.values(removeAt)].filter(Boolean);
}

function overdue(settings) {
  const now = Date.now();
  return deadlines(settings).some((at) => at <= now);
}

// Wakes this worker when the next delayed change is due. The heartbeat is a
// backstop: a single one-shot alarm is one missed wake-up away from leaving
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

// Focus time is counted lazily: nothing runs while it adds up. The focus clock
// runs while blocking is on and someone is at the computer, and focusSince
// marks where the time not yet counted began. Everything that shows or spends
// break time adds that time in (see savedBreak), so counting it changes nothing
// they see. It's counted when the clock stops, and now and then while Chrome
// is in use, so that little is lost if Chrome closes (see startSession).
//
// Returns the changes that count the focus time up to `now`, and either keep
// the clock running from there or stop it.
function countFocus(settings, now, keepRunning) {
  const earned = settings.earned + uncountedBreak(settings, now);
  if (keepRunning)
    return { earned, ...startFocusClock({ ...settings, earned }, now) };
  return { earned, focusSince: null, focusUntil: null };
}

// The focus clock stops earning once the break saved up is full. Working out
// when that is up front, rather than capping the total when the time is
// counted, keeps the cap right even if a break is taken before then.
function startFocusClock({ earned, spent }, now) {
  const room = Math.max(0, MAX_SAVED_MS - (earned - spent));
  return { focusSince: now, focusUntil: now + room * FOCUS_PER_BREAK };
}

// Counts the focus time so far, if it has been a while.
async function countFocusSoFar() {
  const settings = await loadSettings();
  const now = Date.now();
  if (settings.focusSince && now - settings.focusSince >= COUNT_EVERY_MS) {
    await chrome.storage.local.set(countFocus(settings, now, true));
  }
}

// Stepping away from the computer stops the focus clock, and coming back
// starts it again. A computer usually locks when it goes to sleep, so this
// leaves out time asleep too.
async function followIdleState(state) {
  const settings = await loadSettings();
  const { enabled, sites, focusSince } = settings;
  const now = Date.now();
  if (state !== "active" && focusSince) {
    await chrome.storage.local.set(countFocus(settings, now, false));
  } else if (state === "active" && !focusSince && enabled && sites.length > 0) {
    await chrome.storage.local.set(startFocusClock(settings, now));
  }
}

// chrome.storage.session starts out empty each time Chrome starts. Focus time
// that was still uncounted when Chrome closed is dropped, since there's no
// telling how much of it Chrome was open for: at most the time since Chrome
// was last in use (see countFocusSoFar).
async function startSession() {
  const { started } = await chrome.storage.session.get("started");
  if (started) return;
  await chrome.storage.session.set({ started: true });
  const settings = await loadSettings();
  if (settings.focusSince)
    await chrome.storage.local.set(startFocusClock(settings, Date.now()));
}

async function atComputer() {
  try {
    return (await chrome.idle.queryState(IDLE_AFTER_SECONDS)) === "active";
  } catch {
    // chrome.idle is missing until the extension is reloaded with the
    // permission in its manifest. Counting the time beats counting none.
    return true;
  }
}

function onlyFocusCount(changes) {
  return Object.keys(changes).every((key) => FOCUS_COUNT_KEYS.includes(key));
}

// A delayed change must not run late because a wake-up ran late or went
// missing (see requestOverdueChanges). Blocking staying off past enableAt is
// the case that matters most.
async function finishIfOverdue() {
  if (overdue(await loadSettings())) scheduleApply();
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

// Settings can change in quick succession; apply them one at a time. The focus
// count goes in the same line, so the two never overwrite each other's
// focusSince. A new session is set up before anything else runs.
let queue = startSession().catch(console.error);
function enqueue(task) {
  queue = queue.then(task).catch(console.error);
}
function scheduleApply() {
  enqueue(applySettings);
}

// Chrome is in use: a chance to count the focus time so far, and to notice a
// missed wake-up for free (see finishIfOverdue).
function chromeInUse() {
  enqueue(countFocusSoFar);
  finishIfOverdue();
}

chrome.runtime.onInstalled.addListener(scheduleApply);
chrome.runtime.onStartup.addListener(scheduleApply);
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === HEARTBEAT) finishIfOverdue();
  else scheduleApply();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message === "finish-overdue-changes") scheduleApply();
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Counting focus changes nothing about blocking.
  if (area === "local" && !onlyFocusCount(changes)) scheduleApply();
});

// Idle events have to use the same threshold as atComputer.
chrome.idle?.setDetectionInterval(IDLE_AFTER_SECONDS);
chrome.idle?.onStateChanged.addListener((state) =>
  enqueue(() => followIdleState(state)),
);

// Safety net for pages shown without a network request (e.g. restored from
// the back/forward cache), which the rule above never sees.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Reloading a page leaves the URL unchanged, so changeInfo carries no url at
  // all: watch for the load itself as well, or a reload slips through.
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  enqueue(countFocusSoFar);
  const settings = await loadSettings();
  if (settings.enabled) blockTabIfNeeded(tabId, tab.url, settings.sites);
  if (overdue(settings)) scheduleApply();
});

// These fire on the things a person does constantly in Chrome, including
// switching to another app.
chrome.tabs.onActivated.addListener(chromeInUse);
chrome.windows.onFocusChanged.addListener(chromeInUse);
