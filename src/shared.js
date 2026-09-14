// Helpers shared by the background worker, the popup and the blocked page.

export const DEFAULT_SETTINGS = { enabled: true, sites: [] };

export function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export function blockedPageUrl(originalUrl) {
  return `${chrome.runtime.getURL('src/blocked.html')}#${originalUrl}`;
}

// Turns user input like "https://www.YouTube.com/watch?v=1" into "youtube.com".
// Returns null if the input doesn't look like a website.
export function normalizeSite(input) {
  let text = String(input).trim().toLowerCase().replace(/^\*\./, '');
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `http://${text}`;

  let host;
  try {
    host = new URL(text).hostname;
  } catch {
    return null;
  }

  host = host.replace(/\.$/, '').replace(/^www\./, '');
  const isHostname = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host);
  const looksLikeSite = host.includes('.') || host === 'localhost';
  return isHostname && looksLikeSite ? host : null;
}

// Returns the entry in `sites` that blocks `hostname` (the site itself or a
// parent domain, so "youtube.com" also blocks "m.youtube.com"), or undefined.
export function blockedBy(hostname, sites) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return sites.find((site) => host === site || host.endsWith(`.${site}`));
}
