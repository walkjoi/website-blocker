import { blockedBy, loadSettings, normalizeSite } from './shared.js';

const logo = document.getElementById('logo');
const toggle = document.getElementById('enabled');
const status = document.getElementById('status');
const form = document.getElementById('add-form');
const input = document.getElementById('site-input');
const message = document.getElementById('message');
const blockCurrentButton = document.getElementById('block-current');
const list = document.getElementById('site-list');
const empty = document.getElementById('empty');

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
    showMessage(existing === site ? `${site} is already blocked.` : `Already blocked by ${existing}.`);
    return false;
  }
  save({ sites: [...settings.sites, site].sort() });
  return true;
}

function removeSite(site) {
  save({ sites: settings.sites.filter((s) => s !== site) });
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
  const { enabled, sites } = settings;

  toggle.checked = enabled;
  document.body.classList.toggle('off', !enabled);
  logo.src = `../icons/${enabled ? 'on' : 'off'}-32.png`;

  if (!enabled) status.textContent = 'Blocking is off';
  else if (sites.length === 0) status.textContent = 'Add a site to start blocking';
  else status.textContent = `Blocking ${sites.length} site${sites.length === 1 ? '' : 's'}`;

  list.replaceChildren(...sites.map(renderSite));
  empty.hidden = sites.length > 0;

  const canBlockCurrent = currentSite && !blockedBy(currentSite, sites);
  blockCurrentButton.hidden = !canBlockCurrent;
  if (canBlockCurrent) blockCurrentButton.textContent = `+ Block ${currentSite}`;
}

function renderSite(site) {
  const item = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = site;
  name.title = site;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.title = `Remove ${site}`;
  remove.setAttribute('aria-label', `Remove ${site}`);
  remove.addEventListener('click', () => removeSite(site));

  item.append(name, remove);
  return item;
}

toggle.addEventListener('change', () => save({ enabled: toggle.checked }));

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!input.value.trim()) return;
  const site = normalizeSite(input.value);
  if (!site) {
    showMessage('Enter a website, like youtube.com');
    return;
  }
  if (addSite(site)) {
    input.value = '';
    showMessage('');
  }
});

input.addEventListener('input', () => showMessage(''));

blockCurrentButton.addEventListener('click', () => addSite(currentSite));

render();
