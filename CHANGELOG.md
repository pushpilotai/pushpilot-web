# Changelog

## 1.1.0 (unreleased)

In-app messages.

- On page load and when the page becomes visible (at most once a minute), fetches the in-app messages this browser may see from `GET /api/sdk/v1/in-app/`, once the browser is registered.
- Caches each message's page and assets in IndexedDB before it can show, with the assets inlined as `data:` URIs; the light page on devices reporting under 3 GB (`navigator.deviceMemory`).
- Shows a message in a full-viewport transparent `iframe` (`srcdoc`, `sandbox="allow-scripts"`) with a content security policy that allows network requests only to the app's allowed origins, and the `window.pushpilot` bridge: `close`, `open`, `haptic`, `track`, `insets`, `island` (always `null`), `target`, `platform` (`"web"`), `light`, `posture` (always `flat`, with the viewport size) and `onPosture`.
- `showInApp(name): Promise<boolean>` shows the first eligible message with that trigger name; `app_open` messages show once per page load or return to the page.
- `markView(selector, name)` names the element a coach-mark message points at.
- Per-device cap (the larger of the local and server counts) and start and end dates are checked on the device.
- Reports `shown`, `clicked` (with the button id) and `dismissed` to `POST /api/sdk/v1/in-app/events/` in batches of 100, retried like push events.
- `forget()` also clears the in-app cache and queued in-app events.

## 1.0.0 (2026-11-17)

First public release, on npm as `@pushpilotai/web`.

- Subscribes the browser with the web app's own VAPID key (standard Web Push, no Firebase) and registers it with PushPilot.
- Service worker `pushpilot-sw.js` shows PushPilot pushes with title, body, image and up to three buttons, opens links on a click, and reports `delivered` and `clicked` (with the button id).
- `init`, `subscribe`, `unsubscribe`, `setExternalUserId`, `logout`, `setTopics`, `setAttributes`, `forget` and `isSupported`.
- The backend address is configurable with `init(sdkKey, { baseUrl })` (default `https://pushpilot.ai`).
- ES module for bundlers and `pushpilot.js` for a script tag.
