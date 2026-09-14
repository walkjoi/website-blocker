import { blockedBy, blockedPageUrl, loadSettings } from './shared.js';

const RULE_ID = 1;

// Mirrors the saved settings into a single declarativeNetRequest rule, so
// Chrome redirects blocked sites to the blocked page before they load.
async function applySettings() {
  const { enabled, sites } = await loadSettings();
  const active = enabled && sites.length > 0;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: active
      ? [
          {
            id: RULE_ID,
            action: {
              type: 'redirect',
              // \0 is the full original URL, passed along so the blocked page can show it.
              redirect: { regexSubstitution: blockedPageUrl('\\0') },
            },
            condition: {
              regexFilter: '^.+$',
              requestDomains: sites,
              resourceTypes: ['main_frame', 'sub_frame'],
            },
          },
        ]
      : [],
  });

  await updateIcon(enabled);

  // Tabs that were already open on a blocked site get blocked right away.
  if (active) {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) blockTabIfNeeded(tab.id, tab.url, sites);
  }

  // Now that the rule is current, open blocked pages can safely continue to
  // sites that are no longer blocked. (Fails harmlessly if none are open.)
  chrome.runtime.sendMessage('settings-applied').catch(() => {});
}

function blockTabIfNeeded(tabId, url, sites) {
  if (!url || !/^https?:/.test(url)) return;
  if (blockedBy(new URL(url).hostname, sites)) {
    chrome.tabs.update(tabId, { url: blockedPageUrl(url) });
  }
}

function updateIcon(enabled) {
  const state = enabled ? 'on' : 'off';
  const path = {};
  for (const size of [16, 32, 48, 128]) path[size] = `/icons/${state}-${size}.png`;
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
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') scheduleApply();
});

// Safety net for pages shown without a network request (e.g. restored from
// the back/forward cache), which the rule above never sees.
chrome.tabs.onUpdated.addListener(async (tabId, { url }) => {
  if (!url) return;
  const { enabled, sites } = await loadSettings();
  if (enabled) blockTabIfNeeded(tabId, url, sites);
});
