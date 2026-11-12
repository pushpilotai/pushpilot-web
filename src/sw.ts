// PushPilot service worker. Host it as /pushpilot-sw.js, or importScripts() it from the site's own
// worker. It reads the SDK key, base URL and installation id from IndexedDB, where the page stored them.
import { ensureSubscription, flush, log, track } from "./engine";
import { readState, writeState } from "./store";

declare const self: ServiceWorkerGlobalScope;

/** A PushPilot push: payload v2 as flat JSON (GO-LIVE "Design: web push"). */
interface Push {
  source: "pushpilot";
  notification_id: string;
  title: string;
  body?: string;
  image_url?: string;
  url?: string;
  buttons?: { id: string; label: string; url?: string }[];
  data?: Record<string, string>;
}

/** Notification options including the fields TypeScript's lib leaves out. */
type Options = NotificationOptions & { image?: string; actions?: { action: string; title: string }[] };

const MAX_BUTTONS = 3;

/** Reads a push message; null for anything that is not a PushPilot push with an id and a title. */
function parse(data: PushMessageData | null): Push | null {
  let json: Partial<Push> | null = null;
  try {
    json = data?.json() ?? null;
  } catch {
    return null; // not JSON, so not ours
  }
  if (!json || json.source !== "pushpilot") return null;
  if (typeof json.notification_id !== "string" || typeof json.title !== "string" || !json.title) {
    log("PushPilot push without a notification id or title; not shown");
    return null;
  }
  return json as Push;
}

/** How many buttons this browser can show (none where Notification.maxActions is missing). */
function maxButtons(): number {
  const max = (Notification as unknown as { maxActions?: number }).maxActions;
  return Math.min(MAX_BUTTONS, typeof max === "number" ? max : 0);
}

/** Shows the notification, keeping the whole push in `data` for the click handler, then reports delivery. */
async function show(push: Push): Promise<void> {
  const options: Options = {
    body: push.body,
    image: push.image_url,
    tag: push.notification_id,
    data: { pushpilot: push },
    actions: (Array.isArray(push.buttons) ? push.buttons : []).slice(0, maxButtons()).map((b) => ({ action: b.id, title: b.label })),
  };
  await self.registration.showNotification(push.title, options);
  await report(push.notification_id, "delivered");
}

/** Queues an event and tries to send it now; failures stay queued for the next flush. */
async function report(notificationId: string, type: "delivered" | "clicked", buttonId?: string): Promise<void> {
  try {
    await track(notificationId, type, buttonId);
    await flush();
  } catch (error) {
    log(`event not sent: ${(error as Error)?.message}`);
  }
}

/** The link a click opens: the button's for a button (none means dismiss only), else the push's or the site. */
function clickTarget(push: Push, action: string, scope: string): string | undefined {
  if (action) return push.buttons?.find((b) => b.id === action)?.url;
  return push.url ?? scope;
}

/** Focuses a window already showing `url`, or opens a new one. */
async function open(url: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((w) => w.url === url);
  if (existing) await existing.focus();
  else await self.clients.openWindow(url);
}

self.addEventListener("push", (event) => {
  const push = parse(event.data);
  if (push) event.waitUntil(show(push));
});

self.addEventListener("notificationclick", (event) => {
  const push = (event.notification.data as { pushpilot?: Push } | null)?.pushpilot;
  if (!push) return; // someone else's notification (site worker that imports this one)
  event.notification.close();
  const url = clickTarget(push, event.action, self.registration.scope);
  // Opening first, while the browser still counts the click as a user gesture.
  const opening = url ? open(url).catch((error) => log(`link not opened: ${(error as Error)?.message}`)) : undefined;
  event.waitUntil(Promise.all([opening, report(push.notification_id, "clicked", event.action || undefined)]));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe());
});

/** The browser dropped or rotated the subscription: subscribe again with this app's key and re-register. */
async function resubscribe(): Promise<void> {
  const state = await readState();
  if (!state.sdk_key || state.opted_out) return;
  try {
    await ensureSubscription(self.registration, state);
  } catch (error) {
    log(`resubscribe failed: ${(error as Error)?.message}`);
    await writeState({ web_push: undefined });
  }
  await flush();
}

// Only as the site's whole worker: take over at once, so a worker it replaces (OneSignal's) stops
// receiving our pushes. Imported into the site's own worker, its lifecycle stays the site's.
if (/\/pushpilot-sw\.js$/.test(self.location.pathname)) {
  self.addEventListener("install", () => void self.skipWaiting());
}
