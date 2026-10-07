import {
  DEFAULT_SETTINGS,
  MAX_SAVED_MS,
  REMOVE_DELAY_MS,
  blockedBy,
  canTakeBreak,
  countdown,
  endBreak,
  focusMinutes,
  focusUntilBreak,
  loadSettings,
  minutesLabel,
  normalizeSite,
  savedBreak,
  takeBreak,
  updateCountdowns,
} from "./shared.js";

const logo = document.getElementById("logo");
const toggle = document.getElementById("enabled");
const status = document.getElementById("status");
const breakButton = document.getElementById("break");
const form = document.getElementById("add-form");
const input = document.getElementById("site-input");
const message = document.getElementById("message");
const blockCurrentButton = document.getElementById("block-current");
const list = document.getElementById("site-list");
const empty = document.getElementById("empty");

let settings = await loadSettings();
const currentSite = await getCurrentSite();
// What focusMinutes was when the page last rendered.
let shownFocus;

// Saving to storage is all it takes: the background worker picks up the change.
function save(changes) {
  settings = { ...settings, ...changes };
  render();
  return chrome.storage.local.set(changes);
}

function addSite(site) {
  const existing = blockedBy(site, settings.sites);
  if (existing) {
    showMessage(
      existing === site
        ? `${site} is already blocked.`
        : `Already blocked by ${existing}.`,
    );
    return false;
  }
  save({ sites: [...settings.sites, site].sort() });
  return true;
}

// While blocking is on, a site stays blocked for a while after you remove it.
function removeSite(site) {
  if (settings.enabled) {
    save({
      removeAt: { ...settings.removeAt, [site]: Date.now() + REMOVE_DELAY_MS },
    });
  } else {
    save({ sites: settings.sites.filter((s) => s !== site) });
  }
}

function cancelRemoval(site) {
  const { [site]: _, ...removeAt } = settings.removeAt;
  save({ removeAt });
}

async function getCurrentSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url && /^https?:/.test(tab.url) ? normalizeSite(tab.url) : null;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

function render() {
  const { enabled, sites, enableAt } = settings;
  const onBreak = !enabled && enableAt;
  const saved = savedBreak(settings);
  shownFocus = focusMinutes(settings);

  toggle.checked = enabled;
  // Blocking only turns off for a break, so there has to be one to take.
  toggle.disabled = enabled && !canTakeBreak(settings);
  document.body.classList.toggle("off", !enabled);
  logo.src = `../icons/${enabled ? "on" : "off"}-32.png`;

  if (onBreak) {
    status.replaceChildren("On a break, back on in ", countdown(enableAt));
    breakButton.textContent = "Back to work";
  } else if (!enabled) status.textContent = "Blocking is off";
  else if (sites.length === 0)
    status.textContent = "Add a site to start blocking";
  else if (canTakeBreak(settings)) {
    const full = saved >= MAX_SAVED_MS ? " (full)" : "";
    const length = minutesLabel(saved, Math.floor);
    status.textContent = `${length} of break saved${full}`;
    breakButton.textContent = "Take it";
  } else {
    const focus = minutesLabel(focusUntilBreak(settings), Math.ceil);
    status.textContent = `Next break after ${focus} of focus`;
  }
  breakButton.hidden = !onBreak && !canTakeBreak(settings);

  list.replaceChildren(...sites.map(renderSite));
  empty.hidden = sites.length > 0;

  const canBlockCurrent = currentSite && !blockedBy(currentSite, sites);
  blockCurrentButton.hidden = !canBlockCurrent;
  if (canBlockCurrent)
    blockCurrentButton.textContent = `+ Block ${currentSite}`;

  updateCountdowns();
}

function renderSite(site) {
  const item = document.createElement("li");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = site;
  name.title = site;
  item.append(name);

  const removeAt = settings.removeAt[site];
  if (removeAt) {
    item.classList.add("removing");
    const time = countdown(removeAt);
    time.title = `Time until ${site} is removed`;

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel";
    cancel.textContent = "Cancel";
    cancel.setAttribute("aria-label", `Keep blocking ${site}`);
    cancel.addEventListener("click", () => cancelRemoval(site));

    item.append(time, cancel);
    return item;
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = `Remove ${site}`;
  remove.setAttribute("aria-label", `Remove ${site}`);
  remove.addEventListener("click", () => removeSite(site));

  item.append(remove);
  return item;
}

// Switching off takes the break that's saved; switching back on ends it early,
// and saves what's left of it for later.
toggle.addEventListener("change", () => {
  if (toggle.checked) save(endBreak(settings));
  else if (canTakeBreak(settings)) save(takeBreak(settings));
  else render();
});

breakButton.addEventListener("click", () => {
  if (!settings.enabled) save(endBreak(settings));
  // The break may have been taken from a blocked page since this last rendered.
  else if (canTakeBreak(settings)) save(takeBreak(settings));
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!input.value.trim()) return;
  const site = normalizeSite(input.value);
  if (!site) {
    showMessage("Enter a website, like youtube.com");
    return;
  }
  if (addSite(site)) {
    input.value = "";
    showMessage("");
  }
});

input.addEventListener("input", () => showMessage(""));

blockCurrentButton.addEventListener("click", () => addSite(currentSite));

// The background worker saves settings too: when a delayed change goes through,
// and when it counts focus time.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue ?? DEFAULT_SETTINGS[key];
  }
  render();
});

// Focus time adds up without anything being saved (see savedBreak).
setInterval(() => {
  updateCountdowns();
  if (focusMinutes(settings) !== shownFocus) render();
}, 1000);
render();
