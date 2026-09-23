import {
  DEFAULT_SETTINGS,
  REENABLE_DELAY_MS,
  UNBLOCK_DELAY_MS,
  blockedBy,
  countdown,
  loadSettings,
  minutesLabel,
  normalizeSite,
  updateCountdowns,
} from "./shared.js";

const logo = document.getElementById("logo");
const toggle = document.getElementById("enabled");
const status = document.getElementById("status");
const cancelButton = document.getElementById("cancel");
const form = document.getElementById("add-form");
const input = document.getElementById("site-input");
const message = document.getElementById("message");
const blockCurrentButton = document.getElementById("block-current");
const list = document.getElementById("site-list");
const empty = document.getElementById("empty");

let settings = await loadSettings();
const currentSite = await getCurrentSite();

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
      removeAt: { ...settings.removeAt, [site]: Date.now() + UNBLOCK_DELAY_MS },
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
  const { enabled, sites, readyAt, readyUntil, enableAt } = settings;

  toggle.checked = enabled;
  // While the wait runs, Cancel is the only thing to do with the switch.
  toggle.disabled = Boolean(readyAt);
  document.body.classList.toggle("off", !enabled);
  logo.src = `../icons/${enabled ? "on" : "off"}-32.png`;

  if (readyAt) {
    status.replaceChildren("You can turn blocking off in ", countdown(readyAt));
    cancelButton.textContent = "Cancel";
  } else if (readyUntil) {
    status.replaceChildren(
      `Ready: switch off for ${minutesLabel(REENABLE_DELAY_MS)}. Offer ends in `,
      countdown(readyUntil),
    );
    cancelButton.textContent = "Dismiss";
  } else if (!enabled && enableAt)
    status.replaceChildren("Blocking is off, back on in ", countdown(enableAt));
  else if (!enabled) status.textContent = "Blocking is off";
  else if (sites.length === 0)
    status.textContent = "Add a site to start blocking";
  else
    status.textContent = `Blocking ${sites.length} site${sites.length === 1 ? "" : "s"}`;
  cancelButton.hidden = !(readyAt || readyUntil);

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

toggle.addEventListener("change", () => {
  if (toggle.checked) {
    save({ enabled: true, readyAt: null, readyUntil: null, enableAt: null });
  } else if (settings.readyUntil && settings.readyUntil > Date.now()) {
    // Taking the offer: blocking turns off now, for a while.
    save({
      enabled: false,
      readyUntil: null,
      enableAt: Date.now() + REENABLE_DELAY_MS,
    });
  } else {
    // Starting the wait. Blocking stays on until it ends (see render).
    save({ readyAt: Date.now() + UNBLOCK_DELAY_MS });
  }
});

cancelButton.addEventListener("click", () =>
  save({ readyAt: null, readyUntil: null }),
);

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

// The background worker saves settings too, when a delayed change goes through.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue ?? DEFAULT_SETTINGS[key];
  }
  render();
});

setInterval(updateCountdowns, 1000);
render();
