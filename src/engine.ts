// The sync and events engine, shared by the page and the service worker. Mirrors Android's Engine:
// the whole desired state lives in storage, a sync is due whenever the body built from it differs
// from the last one the server accepted, and events go out in batches with the same backoff.
import { addEvent, clearEvents, deleteEvents, peekEvents, readState, writeState, type State, type TrackedEvent } from "./store";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
export const MAX_EVENTS = 1000;
export const EVENT_BATCH = 100;

/** One HTTP answer; code -1 means none arrived (offline, CORS failure, DNS). */
interface Answer {
  code: number;
  body: string;
  retryAfterSeconds: number;
}

/** Debug-level log; callers never pass the SDK key or the push endpoint. */
export function log(message: string): void {
  console.debug(`[PushPilot] ${message}`);
}

/** Calls the SDK API with the app's public key; any failure to get an answer becomes code -1. */
async function request(state: State, method: "GET" | "POST", path: string, body?: string): Promise<Answer> {
  const headers: Record<string, string> = { "X-SDK-Key": state.sdk_key ?? "" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(`${state.base_url}/api/sdk/v1/${path}/`, { method, headers, body });
    // Readable cross-origin only if the server exposes it; otherwise 0 and the backoff alone applies.
    const retryAfter = Number(response.headers.get("Retry-After"));
    return { code: response.status, body: await response.text(), retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 0 };
  } catch (error) {
    log(`${path} request failed: ${(error as Error)?.name ?? "error"}`);
    return { code: -1, body: "", retryAfterSeconds: 0 };
  }
}

/** POSTs and returns the answer once settled (2xx, or a 4xx retrying cannot fix); null when a retry is due. */
async function post(state: State, path: string, json: string): Promise<Answer | null> {
  const answer = await request(state, "POST", path, json);
  const code = answer.code;
  if (code === 429 || code >= 500 || code < 0) {
    state.failures = (state.failures ?? 0) + 1;
    state.blocked_until = Date.now() + Math.max(backoff(state.failures), answer.retryAfterSeconds * 1000);
    await writeState({ failures: state.failures, blocked_until: state.blocked_until });
    return null;
  }
  if (state.failures) {
    state.failures = undefined;
    await writeState({ failures: undefined });
  }
  if (code < 200 || code > 299) log(`${path} rejected with HTTP ${code}; not retried`);
  return answer;
}

/** 1 s doubling to 5 min, each wait randomised to between half and all of it. */
function backoff(failures: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 20));
  return base / 2 + Math.random() * (base / 2);
}

/** The browser's permission in the server's words; "default" (never asked) is "unknown", as on iOS. */
export function permission(): "granted" | "denied" | "unknown" {
  const value = typeof Notification === "undefined" ? "default" : Notification.permission;
  return value === "default" ? "unknown" : value;
}

const BROWSERS: [string, RegExp][] = [
  ["Edge", /Edg\/(\d+)/],
  ["Opera", /OPR\/(\d+)/],
  ["Samsung Internet", /SamsungBrowser\/(\d+)/],
  ["Firefox", /Firefox\/(\d+)/],
  ["Chrome", /Chrome\/(\d+)/],
  ["Safari", /Version\/(\d+).*Safari/],
];

/** Browser name and major version, e.g. "Chrome 131", for device lookup; empty when unknown. */
export function browser(userAgent: string): string {
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  return "";
}

/** Fields read on every sync; the same in the page and the worker, so neither causes a resync. */
function deviceFields(): Record<string, string> {
  return {
    notification_permission: permission(),
    sdk_version: __SDK_VERSION__,
    device_model: browser(navigator.userAgent).slice(0, 100),
    locale: (navigator.language ?? "").slice(0, 35),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
  };
}

/** Builds the full register/sync body; absent topics and attributes mean the site never set them. */
export function payload(state: State): Record<string, unknown> {
  const body: Record<string, unknown> = {
    installation_id: state.installation_id,
    token_kind: "webpush",
    web_push: state.web_push ?? null,
    external_user_id: state.external_user_id ?? null,
    ...deviceFields(),
  };
  if (state.topics) body.topics = state.topics;
  if (state.attributes) body.attributes = state.attributes;
  return body;
}

/** True when there is no accepted sync from the last 24 hours (or the clock moved back). */
export function stale(state: State): boolean {
  const age = Date.now() - (state.last_synced_at ?? 0);
  return !(age >= 0 && age < DAY_MS);
}

/** Syncs if the body differs from the last accepted one; false when a retry is due. */
async function sync(state: State): Promise<boolean> {
  // Web differs from mobile here: a visitor is registered only once the browser has a push address.
  if (state.last_synced_at === undefined && !state.web_push) return true;
  const body = payload(state);
  const json = JSON.stringify(body);
  if (json === state.last_sent_payload) return true;
  const answer = await post(state, state.last_synced_at === undefined ? "register" : "sync", json);
  if (!answer) return false;
  if (answer.code < 200 || answer.code > 299) return true;
  let reply: { installation_id?: unknown; warnings?: unknown } = {};
  try {
    reply = JSON.parse(answer.body);
  } catch {
    // An unreadable 2xx body still means the sync was accepted.
  }
  if (Array.isArray(reply.warnings) && reply.warnings.length) log(`server warnings: ${JSON.stringify(reply.warnings)}`);
  const id = reply.installation_id;
  if (typeof id === "string" && id !== state.installation_id && UUID.test(id)) body.installation_id = id;
  // Remember what was sent, not the state now: a change made meanwhile must still go out.
  await writeState({ installation_id: body.installation_id as string, last_sent_payload: JSON.stringify(body), last_synced_at: Date.now() });
  return true;
}

/** Sends queued events oldest first, up to 100 per request; a rejected batch is dropped, a failed one kept. */
async function sendEvents(state: State): Promise<boolean> {
  for (;;) {
    const { keys, events } = await peekEvents(EVENT_BATCH);
    if (events.length === 0) return true;
    if (!(await post(state, "events", JSON.stringify({ events })))) return false;
    await deleteEvents(keys);
  }
}

/** One pass: a pending forget, then the sync, then events. Returns ms until a retry is due, 0 when settled. */
async function flushOnce(): Promise<number> {
  const state = await readState();
  if (!state.sdk_key || !state.base_url || !state.installation_id) return 0;
  const wait = (state.blocked_until ?? 0) - Date.now();
  if (wait > 0) return wait;
  const retry = () => Math.max(1, (state.blocked_until ?? 0) - Date.now());
  if (state.pending_forget_id) {
    if (!(await post(state, "forget", JSON.stringify({ installation_id: state.pending_forget_id })))) return retry();
    await writeState({ pending_forget_id: undefined });
  }
  if (!(await sync(state))) return retry();
  if (!(await sendEvents(state))) return retry();
  return 0;
}

/** Runs one flush at a time across the page and the worker where the browser has Web Locks. */
export function flush(): Promise<number> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? (locks.request("pushpilot-flush", flushOnce) as unknown as Promise<number>) : flushOnce();
}

/** Queues a tracking event for this installation; the oldest are dropped past the cap. */
export async function track(notificationId: string, type: TrackedEvent["type"], buttonId?: string): Promise<void> {
  const { installation_id } = await readState();
  if (!installation_id) return log("event not recorded: init has never run on this site");
  const event: TrackedEvent = { notification_id: notificationId, installation_id, type, at: new Date().toISOString() };
  if (buttonId) event.button_id = buttonId;
  if ((await addEvent(event, MAX_EVENTS)) > 0) log("event queue full; dropped the oldest");
}

/** Deletes this installation on the server (at the next flush) and resets to a fresh one. */
export async function forget(): Promise<void> {
  const state = await readState();
  // A never-synced id has no server row; keep any earlier forget that is still pending.
  const forgetId = state.last_synced_at !== undefined ? state.installation_id : state.pending_forget_id;
  const fresh: State = { sdk_key: state.sdk_key, base_url: state.base_url, installation_id: crypto.randomUUID() };
  await writeState({
    ...fresh,
    pending_forget_id: forgetId,
    web_push: undefined,
    external_user_id: undefined,
    topics: undefined,
    attributes: undefined,
    last_synced_at: undefined,
    // Nothing is registered again until the browser subscribes or the next page load.
    last_sent_payload: JSON.stringify(payload(fresh)),
  });
  await clearEvents();
}

/** Fetches the app's VAPID public key, cached for a day. Throws when the server cannot give one. */
export async function vapidKey(state: State): Promise<string> {
  const age = Date.now() - (state.vapid_fetched_at ?? 0);
  if (state.vapid_public_key && age >= 0 && age < DAY_MS) return state.vapid_public_key;
  const answer = await request(state, "GET", "web-config");
  if (answer.code !== 200) throw new Error(`web-config answered HTTP ${answer.code}`);
  const key = (JSON.parse(answer.body) as { vapid_public_key?: unknown }).vapid_public_key;
  if (typeof key !== "string" || fromBase64Url(key).length !== 65) throw new Error("web-config gave no valid vapid_public_key");
  await writeState({ vapid_public_key: key, vapid_fetched_at: Date.now() });
  state.vapid_public_key = key;
  return key;
}

/** Decodes base64url (with or without padding) to bytes. */
export function fromBase64Url(text: string): Uint8Array {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/** True when two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Makes sure `registration` holds a subscription made with this app's key and stores its address.
 * A subscription made with another key (OneSignal, or a rotated key) is replaced; with permission
 * already granted the browser does not prompt again.
 */
export async function ensureSubscription(registration: ServiceWorkerRegistration, state: State): Promise<void> {
  const key = fromBase64Url(await vapidKey(state));
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const current = subscription.options?.applicationServerKey;
    // Without the key to compare (older browsers), trust a subscription only if it is the one we stored.
    const ours = current ? sameBytes(new Uint8Array(current), key) : subscription.endpoint === state.web_push?.endpoint;
    if (!ours) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  await writeState({ web_push: address(subscription) });
}

/** The subscription's endpoint and keys (already base64url in toJSON). */
function address(subscription: PushSubscription): State["web_push"] {
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("the browser gave a subscription without keys");
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
