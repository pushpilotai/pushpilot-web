# @pushpilotai/web

PushPilot's web SDK. It subscribes a visitor's browser with your web app's own VAPID key, registers it with PushPilot, shows PushPilot pushes from a service worker (title, body, image and buttons), opens links on a click, and reports `delivered` and `clicked`. It also shows in-app messages (see [In-app messages](#in-app-messages)). It uses standard Web Push, no Firebase, and has no runtime dependencies.

## Install

**npm:**

```bash
npm install @pushpilotai/web
```

```js
import * as PushPilot from "@pushpilotai/web";
```

**Script tag:** host `dist/pushpilot.js` on your site. It defines a global `PushPilot`.

```html
<script src="/pushpilot.js"></script>
```

Either way, the service worker file is `dist/pushpilot-sw.js` (in the npm package as `@pushpilotai/web/pushpilot-sw.js`).

## Integration: two steps

### 1. Host the service worker

**Your site has no service worker:** copy `pushpilot-sw.js` to the root of your site, so it is served at `https://your-site/pushpilot-sw.js`. Serving it from the root lets its scope cover every page.

**Your site already has a service worker:** do not register a second one at the same scope, because it would replace yours. Add one line to your worker instead and tell the SDK where your worker is:

```js
// in your own /sw.js
importScripts("/pushpilot-sw.js");
```

```js
PushPilot.init("YOUR_SDK_KEY", { serviceWorkerPath: "/sw.js" });
```

Our handlers only touch PushPilot pushes and PushPilot notifications. Your own `push` and `notificationclick` handlers keep working. Imported this way, the worker leaves your lifecycle alone. As the whole worker, it calls `skipWaiting()` so it takes over at once from a worker it replaces.

### 2. Start the SDK and ask for permission

```html
<script src="/pushpilot.js"></script>
<script>
  PushPilot.init("YOUR_SDK_KEY");
  document.querySelector("#notify-me").addEventListener("click", async () => {
    const subscribed = await PushPilot.subscribe();
  });
</script>
```

Call `subscribe()` from a click or tap. Browsers show the permission prompt only for a user gesture, and Safari refuses it otherwise.

## API

Setters return at once and never throw. They run one at a time, in order. Calls made before `init` are queued (at most 100) and run after it. Names and behaviour follow the Android SDK.

| Call | What it does |
|---|---|
| `init(sdkKey, { baseUrl?, serviceWorkerPath? })` | Starts the SDK. `baseUrl` defaults to `DEFAULT_BASE_URL`, PushPilot's hosted server. `serviceWorkerPath` defaults to `/pushpilot-sw.js`. Later calls are ignored. |
| `subscribe(): Promise<boolean>` | Asks for permission if it was never asked, registers the worker, fetches the app's key from `GET /api/sdk/v1/web-config/`, subscribes and registers the browser. Resolves `true` when subscribed and `false` otherwise (permission not granted, unsupported browser, or an error, which is logged). It never rejects. |
| `unsubscribe(): Promise<void>` | Removes the browser's subscription and clears the address on the server (`web_push: null`). The browser stays unsubscribed on later visits until `subscribe()` is called again. |
| `setExternalUserId(id \| null)` | Links this browser to your user id after login. `null` clears it. At most 255 characters. |
| `logout()` | Clears the external user id. The browser keeps receiving pushes. |
| `setTopics(string[])` | Replaces the topic list. Names outside `A-Z a-z 0-9 . _ ~ % -` or longer than 255 characters are dropped, the rest are de-duplicated and sorted, and at most 100 are kept. |
| `setAttributes({ name: value })` | Merges attributes declared in the dashboard. A value is a string, a finite number or a boolean. `null` removes the attribute. |
| `forget()` | Deletes this installation from PushPilot and clears local state. The next page load registers a new installation. |
| `showInApp(name): Promise<boolean>` | Shows the first eligible cached in-app message whose trigger name is `name`, with no network request. Resolves `true` when one went on screen. `false` before `init`, when none is eligible, or while another message is showing. |
| `markView(selector, name)` | Names the element a coach-mark message points at, by CSS selector, for example `markView("#compose", "compose")`. |
| `isSupported(): boolean` | True when this browser can receive web push on this page. Use it to hide your button. On iOS it is false until the site is opened from the Home Screen. |
| `DEFAULT_BASE_URL` | The hosted server's URL. |

The SDK logs at `console.debug` with a `[PushPilot]` prefix. It never logs the SDK key or the push endpoint.

## What it sends

Register and sync use the mobile body with `token_kind: "webpush"`, and a `web_push` object in place of `token`:

```json
{
  "installation_id": "…uuid…",
  "token_kind": "webpush",
  "web_push": {"endpoint": "https://fcm.googleapis.com/fcm/send/…", "p256dh": "…", "auth": "…"},
  "external_user_id": null,
  "notification_permission": "granted",
  "sdk_version": "1.1.0",
  "device_model": "Chrome 131",
  "locale": "en-GB",
  "timezone": "Europe/London",
  "topics": ["news"],
  "attributes": {"plan": "pro"}
}
```

`topics` and `attributes` are sent only once you have set them. `notification_permission` is `granted`, `denied`, or `unknown` when the visitor was never asked (the browser's `default`, reported like iOS's "not determined"). `device_model` is the browser name and major version, because web has no device model. `os_version` and `app_version` are not sent.

## How it behaves, and where it differs from Android

Shared with Android:
- Changes made within 2 seconds of each other go out in one sync. A sync is sent only when the body differs from the last one the server accepted, plus once a day.
- Events (`delivered`, `clicked` with `button_id`) are queued, oldest first, up to 1,000. They go out in batches of 100 after a successful sync. A 2xx removes the batch. Another 4xx drops it. A 429, a 5xx or a network error keeps it and waits for the longer of `Retry-After` and a backoff of 1 s doubling to 5 minutes, randomised to between half and all of each step. A pending `forget` is sent before anything else.

Different on the web, and why:
- **State is in IndexedDB**, shared by the page and the service worker. The worker needs the SDK key, the base URL and the installation id when no page is open. Flushes from the page and the worker take turns through the Web Locks API where the browser has it. Where it does not, a batch can occasionally be sent twice, and the server ignores the repeat.
- **The SDK owns the push address.** There is no `setPushToken`, because `subscribe()` creates the address and the worker renews it on `pushsubscriptionchange`.
- **A browser is registered only once it has a push address.** Every visitor would otherwise create a device row on their first page view. User id, topics and attributes set before that are stored and sent with the first registration.
- **With permission already granted, `init` subscribes without a prompt.** This includes a subscription made with another server key, for example a site moving from OneSignal, which is replaced. It also picks up a renewed endpoint and clears the address when permission was withdrawn. The check runs on every page load and whenever the page becomes visible again, which is the web's version of "app foreground".
- **`unsubscribe()` is remembered**, so the automatic re-subscribe above does not undo it.
- **The worker does not wait to retry.** A browser stops a service worker soon after each event, so the worker tries once. Anything left over goes out on the next push, the next click or the next page view.
- **`Retry-After` is read only if the server exposes it** to cross-origin scripts (`Access-Control-Expose-Headers: Retry-After`). Otherwise the backoff alone applies.

## The notification

- The title, body and image come from the push. The whole push is kept in `notification.data.pushpilot`, and the `tag` is the notification id, so a repeated push replaces the earlier one rather than showing twice.
- The SDK shows up to three buttons, or fewer where the browser allows fewer (`Notification.maxActions`). A browser without `maxActions` gets no buttons.
- A click on the body opens the push's `url`. With no `url`, it opens your site (the worker's scope). A window already showing that link is focused instead of opening a new one.
- A button with a `url` opens it. A button without one only closes the notification. Both report `clicked` with the button's id.
- A push whose JSON does not have `source: "pushpilot"` is ignored, so it is left to your own handlers.

## In-app messages

An in-app message is a small HTML page made in the PushPilot dashboard and shown over your site while the visitor has it open. There is nothing to add beyond the push integration above. The SDK fetches, caches and shows messages by itself, and reports what happened.

### Integration

1. **Do the push integration.** In-app messages go to registered browsers, and the web SDK registers a browser once it is subscribed to push (see "A browser is registered only once it has a push address" above). A visitor who has not subscribed, or a browser where `isSupported()` is false, gets no in-app messages.
2. **Messages triggered on app open need nothing more.** On each page load, and whenever the page becomes visible again, the SDK shows the first eligible cached message with the "app open" trigger, at most one each time.
3. **Messages triggered by name.** Call `showInApp` where your site wants one, with the trigger name set in the dashboard:

   ```js
   const shown = await PushPilot.showInApp("checkout");
   ```

   It uses the cache only, so it answers at once. It resolves `false` when nothing is eligible.
4. **Coach marks.** A coach-mark message points at an element of your page. Name that element once with a CSS selector, using the target name from the dashboard:

   ```js
   PushPilot.markView("#compose", "compose");
   ```

   The selector is looked up when the message would show. The first match that is visible and on screen is the target, and its box (`getBoundingClientRect`) is passed to the page as `pushpilot.target`. With no such element, the message is not shown and stays eligible for later.

### How it behaves

- **Fetch:** `GET /api/sdk/v1/in-app/` on page load and when the page becomes visible, at most once a minute, after the browser's first registration.
- **Cache:** each message's page and every asset are downloaded first and kept in IndexedDB (a database of its own, `pushpilot-in-app`), with the assets inlined as `data:` URIs. A message shows only once all of it is cached, so it needs no network. A browser reporting under 3 GB of memory (`navigator.deviceMemory`) gets the message's light version where there is one.
- **Cap and dates:** a message is not shown past its per-browser cap (the larger of this browser's own count and the server's) or outside its start and end dates by the browser's clock.
- **Display:** a full-viewport transparent `iframe` above everything else (`z-index` 2147483647), loaded with `srcdoc` and `sandbox="allow-scripts"`. The page runs in an opaque origin, so it cannot read your site's cookies, storage or DOM, navigate your page, open pop-ups or submit forms. A content security policy limits its network requests to the origins on the app's allow-list in the dashboard, and blocks all others.
- **Links:** the page calls `pushpilot.open(url)`. `javascript:`, `data:`, `file:`, `blob:` and `vbscript:` URLs are refused and the message stays open. Any other URL closes the message and opens in the current tab with `location.assign`. Relative URLs resolve against your page. There is no hook for your own link handler yet, so in a single-page app this is a full page load.
- **Bridge:** `pushpilot.close()`, `open(url)`, `haptic(kind)` (`navigator.vibrate` where the browser has it, nothing elsewhere), `track(buttonId)`, `insets` (from `env(safe-area-inset-*)`, 0 without), `target`, `island` (always `null` on the web), `platform` (`"web"`), `light`, and `posture` with `onPosture(fn)`. On the web, `posture` is always `{state: "flat", screen: {width, height}}` with the viewport size, and it is updated when the window resizes.
- **Events:** `shown` when the page has loaded, `clicked` for each `track` call (button ids of 1 to 64 bytes; others are ignored), and `dismissed` when a showing closes without any `track`. They are queued in IndexedDB and sent to `POST /api/sdk/v1/in-app/events/` in batches of 100, with the same retries as push events.
- `forget()` also clears the in-app cache, counts and queued events.

PushPilot's content host must allow cross-origin `GET` from your site, because the pages and assets are downloaded with `fetch`. On a self-hosted server, set CORS on the bucket or domain serving in-app files.

## Browser support

This has been tested only against fakes so far, not in real browsers (see "Before going live" below).

| Browser | Push | Image | Buttons |
|---|---|---|---|
| Chrome, Edge, Opera, Samsung Internet (desktop and Android) | yes | Windows, ChromeOS and Android only; macOS shows none | 2 |
| Firefox (desktop and Android) | yes | no | no |
| Safari on macOS 13 (Ventura) and later, Safari 16+ | yes | no | no |
| Safari on iOS and iPadOS 16.4 and later | **only for a site added to the Home Screen** | no | no |

On iOS and iPadOS, Safari and the other browsers do not deliver web push to a site open in a tab. The visitor must add the site to their Home Screen and open it from there. The site needs a web app manifest with `"display": "standalone"` (or `"fullscreen"`), and `subscribe()` must run from a tap. Until then, `isSupported()` is false, so you can show your own "Add to Home Screen" hint instead of the button.

Not covered: Safari's older proprietary push (macOS before Ventura).

## Moving from OneSignal

Remove the OneSignal script and its worker registration, then follow the two steps above. On a visitor's next page view, the SDK finds the OneSignal subscription, unsubscribes it and subscribes again with your PushPilot key. Permission is already granted, so the visitor sees no prompt.

This works when the PushPilot worker takes over OneSignal's scope, which is the site root by default. If OneSignal's worker was registered at a different scope, unregister it yourself, or it keeps its own subscription.

## Self-hosted PushPilot

Pass your server's URL:

```js
PushPilot.init("YOUR_SDK_KEY", { baseUrl: "https://push.example.com" });
```

The base URL is stored for the worker. Every request goes to `{baseUrl}/api/sdk/v1/…`.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

```bash
npm run example
```

`npm run typecheck` checks the page code against the DOM types and the worker against the WebWorker types. `npm run example` builds, then serves `example/` on `http://localhost:8080` (set `PORT` to change it). There you enter the SDK key and base URL of a web app whose origin is `http://localhost:8080`, and try every call.

The tests run in Node with fakes for `fetch`, `PushManager`, `Notification`, the worker's registration and clients, and IndexedDB (`fake-indexeddb`). The in-app tests that need a DOM run in `jsdom`. None needs the network.

### Before going live

These need a real browser and the backend half of the contract deployed (`web-config`, `web_push` registration, CORS):
- On Chrome, Firefox, macOS Safari and an iPhone with the site on the Home Screen: subscribe, check the device in device lookup, send a push with an image and buttons, and click the body and each button. Check the counts on the send.
- On a site that has a OneSignal subscription with permission granted: load the page and confirm there is no prompt, the device registers, and a push arrives.
- With the site's own worker importing ours: confirm both its pushes and ours are handled.
- Revoke permission in the browser settings, come back to the page, and confirm the device shows `denied` with no address.
- In-app messages, with `npm run example`: publish an "app open" message and one with a trigger name. Reload, check that the first shows once, that the "showInApp" button shows the second, that its buttons, links and close work, and that the report counts shown, clicked and dismissed. Check a message's transparent areas in a dark-mode browser. Check a coach mark pointing at the "compose" button, and a phone with a notch in landscape for the insets.

## Releasing

See [RELEASING.md](RELEASING.md) and [CHANGELOG.md](CHANGELOG.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
