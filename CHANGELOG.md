# Changelog

## 1.0.0 (unreleased)

First public release, on npm as `@pushpilotai/web`.

- Subscribes the browser with the web app's own VAPID key (standard Web Push, no Firebase) and registers it with PushPilot.
- Service worker `pushpilot-sw.js` shows PushPilot pushes with title, body, image and up to three buttons, opens links on a click, and reports `delivered` and `clicked` (with the button id).
- `init`, `subscribe`, `unsubscribe`, `setExternalUserId`, `logout`, `setTopics`, `setAttributes`, `forget` and `isSupported`.
- The backend address is configurable with `init(sdkKey, { baseUrl })` (default `https://pushpilot.ai`).
- ES module for bundlers and `pushpilot.js` for a script tag.
