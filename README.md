# Site Blocker - Chrome Extension

![preview](image.png)

A small Chrome extension that blocks the websites you choose.

- **One switch** turns blocking on or off.
- **Add or remove sites** from the popup. Type `youtube.com`, paste a full URL, or click **Block \<current site\>**.
- Blocking a site also blocks its subdomains (`youtube.com` covers `m.youtube.com`).
- When blocking is on, any visit to a blocked site shows a "This site is blocked" page. That includes tabs that are already open.
- **Unblocking takes 5 minutes.** When blocking is on, turning it off or removing a site starts a countdown, and blocking continues until the countdown ends. That gives the urge to visit the site time to pass. You can cancel any time before then. Turning blocking on and adding sites happen right away. To change the wait, edit `UNBLOCK_DELAY_MS` in `src/shared.js`.
- **Blocking turns itself back on after 3 minutes off.** Use the switch to turn it on sooner. To change this, edit `REENABLE_DELAY_MS` in `src/shared.js`.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin **Site Blocker** from the puzzle-piece menu so the switch is one click away.

After you edit the code, click the reload icon on the extension's card in `chrome://extensions`.

## How it works

Settings live in `chrome.storage.local` as `{ enabled, sites, disableAt, enableAt, removeAt }`. The popup only writes settings. The background service worker listens for changes and keeps one [`declarativeNetRequest`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) rule in sync with them. The rule sends requests for blocked domains to `src/blocked.html` before the site loads.

Delayed changes are saved as timestamps instead of being made right away: `disableAt` says when blocking turns off, `enableAt` says when it turns back on, and `removeAt` says when each site leaves the list. The background worker makes each change when its time comes, using [`chrome.alarms`](https://developer.chrome.com/docs/extensions/reference/api/alarms) to wake up. If Chrome was closed at that time, the worker makes the change the next time Chrome starts. Alarms can go off late, because Chrome's timers stop while the computer sleeps. So the popup and the blocked page also ask the worker to make the change once a countdown they show has run out. The worker also checks whether blocking should be back on whenever a tab loads a page.

The toolbar icon turns grey when blocking is off.

## Project layout

```
manifest.json         Extension manifest (Manifest V3)
src/background.js     Service worker: syncs the blocking rule, blocks open tabs, makes delayed changes
src/popup.*           Toolbar popup: on/off switch, add/remove sites
src/blocked.*         Page shown in place of a blocked site
src/shared.js         Settings and domain helpers used by all of the above
icons/                Toolbar icons (red = on, grey = off)
scripts/make_icons.py Regenerates the icons (standard-library Python)
```

There is no build step. The folder is the extension.
