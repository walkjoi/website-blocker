import {
  DEFAULT_SETTINGS,
  REENABLE_DELAY_MS,
  UNBLOCK_DELAY_MS,
  blockedBy,
  countdown,
  loadSettings,
  minutesLabel,
  updateCountdowns,
} from "./shared.js";

// The background worker puts the blocked URL after the "#".
const originalUrl = location.hash.slice(1);
let host = "";
try {
  host = new URL(originalUrl).hostname;
} catch {
  // No valid URL; keep the generic "This site" text.
}
const canContinue = Boolean(host) && /^https?:/.test(originalUrl);

if (host) {
  const site = host.replace(/^www\./, "");
  document.getElementById("site").textContent = site;
  document.title = `${site} is blocked`;
}

const status = document.getElementById("status");
const requestButton = document.getElementById("request");
const startButton = document.getElementById("start");
const continueButton = document.getElementById("continue");
const cancelButton = document.getElementById("cancel");
const backButton = document.getElementById("back");

backButton.hidden = history.length < 2;
backButton.addEventListener("click", () => history.back());

// Continue to the site as soon as it's no longer blocked. This waits for the
// background worker's signal rather than watching storage directly, because
// until the worker updates its rule, the rule would just send us back here.
async function continueIfUnblocked() {
  if (!canContinue) return;
  const { enabled, sites } = await loadSettings();
  if (!enabled || !blockedBy(host, sites)) location.replace(originalUrl);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message === "settings-applied") continueIfUnblocked();
});

let settings = {};

// Saving to storage is all it takes: the background worker picks up the change.
function save(changes) {
  settings = { ...settings, ...changes };
  render();
  return chrome.storage.local.set(changes);
}

// The same wait, offer and break the popup's switch goes through, so the
// blocked page is enough on its own: it's where the urge to visit shows up.
function render() {
  const { enabled, sites, readyAt, readyUntil, enableAt, removeAt } = settings;
  const site = blockedBy(host, sites);
  const breakLength = minutesLabel(REENABLE_DELAY_MS);

  let state;
  if (!enabled || !site) state = "unblocked";
  else if (readyUntil) state = "ready";
  else if (removeAt[site]) state = "removing";
  else if (readyAt) state = "waiting";
  else state = "blocked";

  switch (state) {
    case "blocked":
      status.textContent =
        `To visit it, request a break: blocking stays on for ` +
        `${minutesLabel(UNBLOCK_DELAY_MS)}, then you can turn it off for ` +
        `${breakLength}. Or remove the site in the Site Blocker menu.`;
      requestButton.textContent = "Request a break";
      break;
    case "waiting":
      status.replaceChildren(
        "You can turn blocking off in ",
        countdown(readyAt),
        ".",
      );
      break;
    case "ready":
      status.replaceChildren(
        `Ready. Turn blocking off for ${breakLength}? The offer ends in `,
        countdown(readyUntil),
        ".",
      );
      startButton.textContent = `Turn off for ${breakLength}`;
      break;
    case "removing":
      status.replaceChildren(
        `${site} is being removed. This page continues to the site in `,
        countdown(removeAt[site]),
        ".",
      );
      break;
    case "unblocked":
      if (!enabled && enableAt)
        status.replaceChildren(
          "Blocking is off, back on in ",
          countdown(enableAt),
          ".",
        );
      else if (!enabled) status.textContent = "Blocking is off.";
      else status.textContent = "This site is no longer blocked.";
      break;
  }

  requestButton.hidden = state !== "blocked";
  cancelButton.hidden = state !== "waiting";
  startButton.hidden = state !== "ready";
  continueButton.hidden = state !== "unblocked" || !canContinue;
  updateCountdowns();
}

requestButton.addEventListener("click", () =>
  save({ readyAt: Date.now() + UNBLOCK_DELAY_MS }),
);

cancelButton.addEventListener("click", () => save({ readyAt: null }));

startButton.addEventListener("click", () => {
  // The offer may have lapsed since the page last rendered.
  if (!settings.readyUntil || settings.readyUntil <= Date.now()) return;
  save({
    enabled: false,
    readyUntil: null,
    enableAt: Date.now() + REENABLE_DELAY_MS,
  });
});

continueButton.addEventListener("click", () => location.replace(originalUrl));

if (host) {
  settings = await loadSettings();
  render();

  // The popup and the background worker save settings too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue ?? DEFAULT_SETTINGS[key];
    }
    render();
  });

  setInterval(updateCountdowns, 1000);
}
