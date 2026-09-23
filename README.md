# Site Blocker - Chrome Extension

![preview](image.png)

A small Chrome extension that blocks the websites you choose.

- **One switch** turns blocking on or off.
- **Add or remove sites** from the popup. Type `youtube.com`, paste a full URL, or click **Block \<current site\>**.
- Blocking a site also blocks its subdomains (`youtube.com` covers `m.youtube.com`).
- When blocking is on, any visit to a blocked site shows a "This site is blocked" page. That includes tabs that are already open.
- **Turning blocking off is a break you request, then take.** Flip the switch off (or click **Request a break** on the blocked page) and blocking stays on for 5 more minutes, so the urge to visit the site has time to pass. When the wait is over, a notification tells you that you can turn blocking off, and you have 15 minutes to do it: flip the switch again, or click the button on the blocked page. Blocking then stays off for 3 minutes and turns itself back on. If you don't take the offer, it lapses and blocking simply stays on. You can cancel the wait or dismiss the offer at any time. Turning blocking on happens right away.
- **Removing a site takes 5 minutes** too, with the same countdown and Cancel button; the site stays blocked until it ends. Adding sites happens right away.
- The 3 minutes off start when you turn blocking off, so the break is yours to take when you're ready. The 15-minute offer, on the other hand, runs from when the wait was due to end, not from when the extension got around to noticing: quitting Chrome partway through the wait and coming back hours later doesn't produce a fresh offer.
- To change the times, edit `UNBLOCK_DELAY_MS`, `READY_WINDOW_MS` and `REENABLE_DELAY_MS` in `src/shared.js`.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin **Site Blocker** from the puzzle-piece menu so the switch is one click away.

After you edit the code, click the reload icon on the extension's card in `chrome://extensions`.

## How it works

Settings live in `chrome.storage.local` as `{ enabled, sites, readyAt, readyUntil, enableAt, removeAt }`. The popup and the blocked page only write settings. The background service worker listens for changes and keeps one [`declarativeNetRequest`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) rule in sync with them. The rule sends requests for blocked domains to `src/blocked.html` before the site loads.

Delayed changes are saved as timestamps instead of being made right away: `readyAt` says when the wait to turn blocking off ends, `readyUntil` says when the offer that follows lapses, `enableAt` says when blocking turns back on, and `removeAt` says when each site leaves the list. Turning blocking off itself is never delayed: the popup or the blocked page sets `enabled` to false, and `enableAt` to 3 minutes out, at the moment the offer is taken. The background worker makes each timed change when its time comes, using [`chrome.alarms`](https://developer.chrome.com/docs/extensions/reference/api/alarms) to wake up. If Chrome was closed at that time, the worker makes the change the next time Chrome starts — and because `readyUntil` is measured from `readyAt`, an offer that has already lapsed while Chrome was closed is withdrawn before it begins. Alarms can go off late, because Chrome's timers stop while the computer sleeps. So the popup and the blocked page also ask the worker to make the change once a countdown they show has run out. A one-shot alarm is one missed wake-up away from leaving blocking off for good, so while a change is pending a second alarm repeats once a minute as a backstop; both are cleared once nothing is due. The worker also checks whether any change is overdue whenever a tab loads or is switched to, or a Chrome window takes focus.

The toolbar icon turns grey when blocking is off.

## Project layout

```
manifest.json         Extension manifest (Manifest V3)
src/background.js     Service worker: syncs the blocking rule, blocks open tabs, makes delayed changes
src/popup.*           Toolbar popup: on/off switch, add/remove sites
src/blocked.*         Page shown in place of a blocked site: request and take a break from there
src/shared.js         Settings, countdown and domain helpers used by all of the above
icons/                Toolbar icons (red = on, grey = off)
scripts/make_icons.py Regenerates the icons (standard-library Python)
```

There is no build step. The folder is the extension.
