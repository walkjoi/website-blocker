import {
  DEFAULT_SETTINGS,
  FOCUS_PER_BREAK,
  blockedBy,
  borrowBreak,
  borrowOptions,
  canTakeBreak,
  countdown,
  focusMinutes,
  focusUntilBreak,
  loadSettings,
  minutesLabel,
  savedBreak,
  takeBreak,
  updateCountdowns,
} from "./shared.js";

// How long after a borrowed break ends this page still says what it was for.
const REMINDER_MS = 10 * 60 * 1000;

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

const reminder = document.getElementById("reminder");
const status = document.getElementById("status");
const borrowForm = document.getElementById("borrow");
const reasonInput = document.getElementById("reason");
const borrowChoices = document.getElementById("borrow-options");
const takeButton = document.getElementById("take");
const continueButton = document.getElementById("continue");
const backButton = document.getElementById("back");
const borrowButton = document.getElementById("borrow-open");

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
// Whether the form to borrow time is open.
let borrowing = false;
// What focusMinutes was when the page last rendered.
let shownFocus;

// Saving to storage is all it takes: the background worker picks up the change.
function save(changes) {
  settings = { ...settings, ...changes };
  render();
  return chrome.storage.local.set(changes);
}

// The same breaks the popup's switch takes, so the blocked page is enough on
// its own: it's where the urge to visit shows up. It's also the one place to
// borrow time, since that means saying what the site is needed for.
function render() {
  const { enabled, sites, enableAt, removeAt, reason } = settings;
  const site = blockedBy(host, sites);
  const saved = savedBreak(settings);
  const options = borrowOptions(settings);
  shownFocus = focusMinutes(settings);

  let state;
  if (!enabled || !site) state = "unblocked";
  else if (removeAt[site]) state = "removing";
  else if (canTakeBreak(settings)) state = "saved";
  else if (borrowing && options.length > 0) state = "borrowing";
  else state = "focusing";
  if (state !== "borrowing") borrowing = false;

  // A borrowed break that just ran out: whatever it was for should be done.
  const remind =
    (state === "saved" || state === "focusing") &&
    reason &&
    reason.until <= Date.now() &&
    Date.now() - reason.until < REMINDER_MS;
  reminder.hidden = !remind;
  if (remind)
    reminder.textContent = `Time's up. You needed it for “${reason.text}”.`;

  switch (state) {
    case "saved": {
      const length = minutesLabel(saved, Math.floor);
      status.textContent =
        `You've saved ${length} of break. Take it now, and blocking ` +
        `comes back on when it's over.`;
      takeButton.textContent = `Take ${length} off`;
      break;
    }
    case "focusing": {
      const focus = minutesLabel(focusUntilBreak(settings), Math.ceil);
      const sentences = [];
      // Owing a few seconds, after coming back early, isn't worth a mention.
      const owed = minutesLabel(-saved);
      if (Math.round(-saved / 60000) >= 1)
        sentences.push(`You're paying back ${owed} you borrowed.`);
      sentences.push(`Your next break comes after ${focus} of focus.`);
      if (options.length === 0)
        sentences.push("You've borrowed as much as you can.");
      status.textContent = sentences.join(" ");
      break;
    }
    case "borrowing":
      status.textContent =
        `Borrowed time comes out of your next break: each minute takes ` +
        `${minutesLabel(FOCUS_PER_BREAK * 60000)} of focus to pay back.`;
      borrowChoices.replaceChildren(
        ...options.map(borrowChoice),
        cancelBorrowButton(),
      );
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
          "You're on a break. Blocking comes back on in ",
          countdown(enableAt),
          ".",
        );
      else if (!enabled) status.textContent = "Blocking is off.";
      else status.textContent = "This site is no longer blocked.";
      break;
  }

  takeButton.hidden = state !== "saved";
  borrowButton.hidden = state !== "focusing" || options.length === 0;
  borrowForm.hidden = state !== "borrowing";
  continueButton.hidden = state !== "unblocked" || !canContinue;
  backButton.hidden = history.length < 2 || state === "borrowing";
  updateCountdowns();
}

function borrowChoice(ms) {
  const button = document.createElement("button");
  button.type = "submit";
  button.value = ms;
  button.textContent = minutesLabel(ms);
  return button;
}

function cancelBorrowButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet";
  button.textContent = "Cancel";
  button.addEventListener("click", () => {
    borrowing = false;
    render();
  });
  return button;
}

takeButton.addEventListener("click", () => {
  // The break may have been taken from the popup since the page last rendered.
  if (canTakeBreak(settings)) save(takeBreak(settings));
});

borrowButton.addEventListener("click", () => {
  borrowing = true;
  render();
  reasonInput.focus();
});

borrowForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const reason = reasonInput.value.trim();
  if (!reason) {
    // Spaces alone get past `required`.
    reasonInput.value = "";
    reasonInput.reportValidity();
    return;
  }
  // What can be borrowed may have changed since the page last rendered.
  const ms = Number(event.submitter?.value);
  if (!borrowOptions(settings).includes(ms)) return render();
  save(borrowBreak(settings, ms, reason));
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

  // Focus time adds up without anything being saved (see savedBreak).
  setInterval(() => {
    updateCountdowns();
    if (focusMinutes(settings) !== shownFocus) render();
  }, 1000);
}
