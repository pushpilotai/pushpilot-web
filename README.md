# @pushpilotai/web

PushPilot's web push SDK. It subscribes a visitor's browser with your web app's own VAPID key, registers it with PushPilot, shows PushPilot pushes from a service worker (title, body, image and buttons), opens links on a click, and reports `delivered` and `clicked`. It uses standard Web Push, no Firebase, and has no runtime dependencies.

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
  "sdk_version": "1.0.0",
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

## Browser support

This has been tested only against fakes so far, not in real browsers (see "Before going live" below).

| Browser | Push | Image | Buttons |
|---|---|---|---|
| Chrome, Edge, Opera, Samsung Internet (desktop and Android) | yes | Windows, ChromeOS and Android only; macOS shows none | 2 |
| Firefox (desktop and Android) | yes | no | no |
| Safari on macOS 13 (Ventura) and later, Safari 16+ | yes | no | no |
| Safari on iOS and iPadOS 16.4 and later | **only for a site added to the Home Screen** | no | no |

On iOS and iPadOS, Safari and the other browsers do not deliver web push to a site open in a tab. The visitor must add the site to their Home Screen and open it from there. The site needs a web app manifest with `"display": "standalone"` (or `"fullscreen"`), and `subscribe()` must run from a tap. Until then, `isSupported()` is false, so you can show your own "Add to Home Screen" hint instead of the button.

Not covered: Safari's older proprietary push (macOS before Ventura) and in-app messages.

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

The tests run in Node with fakes for `fetch`, `PushManager`, `Notification`, the worker's registration and clients, and IndexedDB (`fake-indexeddb`). None needs the network.

### Before going live

These need a real browser and the backend half of the contract deployed (`web-config`, `web_push` registration, CORS):
- On Chrome, Firefox, macOS Safari and an iPhone with the site on the Home Screen: subscribe, check the device in device lookup, send a push with an image and buttons, and click the body and each button. Check the counts on the send.
- On a site that has a OneSignal subscription with permission granted: load the page and confirm there is no prompt, the device registers, and a push arrives.
- With the site's own worker importing ours: confirm both its pushes and ours are handled.
- Revoke permission in the browser settings, come back to the page, and confirm the device shows `denied` with no address.

## Releasing

See [RELEASING.md](RELEASING.md) and [CHANGELOG.md](CHANGELOG.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
