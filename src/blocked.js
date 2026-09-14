import { blockedBy, loadSettings } from './shared.js';

// The background worker puts the blocked URL after the "#".
const originalUrl = location.hash.slice(1);
let host = '';
try {
  host = new URL(originalUrl).hostname;
} catch {
  // No valid URL; keep the generic "This site" text.
}

if (host) {
  const site = host.replace(/^www\./, '');
  document.getElementById('site').textContent = site;
  document.title = `${site} is blocked`;
}

const backButton = document.getElementById('back');
backButton.hidden = history.length < 2;
backButton.addEventListener('click', () => history.back());

// Continue to the site as soon as it's no longer blocked. This waits for the
// background worker's signal rather than watching storage directly, because
// until the worker updates its rule, the rule would just send us back here.
async function continueIfUnblocked() {
  if (!host || !/^https?:/.test(originalUrl)) return;
  const { enabled, sites } = await loadSettings();
  if (!enabled || !blockedBy(host, sites)) location.replace(originalUrl);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message === 'settings-applied') continueIfUnblocked();
});
