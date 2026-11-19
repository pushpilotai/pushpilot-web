// In-app messages on the page (IN-APP-SDK.md): fetch on page load and when the page becomes
// visible (at most once a minute), cache pages with their assets inlined, show app_open messages
// once per foreground and show_in_app messages on PushPilot.showInApp, and queue shown, clicked
// and dismissed events for /in-app/events/. Page bundle only; the service worker never loads it.
import { log, post, request } from "../engine";
import { readState } from "../store";
import { findTarget, insets, posture, showFrame } from "./frame";
import { cacheKey, isSlowDevice, pageUrl, parseAnswer, pick, type FetchAnswer, type InAppMessage } from "./message";
import { dataUri, framePage, inlineAssets } from "./page";
import { addEvent, clearAll, deleteEvents, get, keys, peekEvents, put, remove, type CachedPage, type InAppEvent } from "./storage";

const FETCH_EVERY_MS = 60_000;
const COALESCE_MS = 2_000;
const MAX_QUEUED = 1000;
const BATCH = 100;

/** Coach-mark names to the CSS selectors the site gave markView. */
const marks = new Map<string, string>();
/** True from the moment a show starts until its message closes, so two never overlap. */
let onScreen = false;
/** True until this foreground has tried its app_open message. */
let appOpenDue = true;
let refreshing = false;
let flushScheduled = false;

/** Names the elements a coach mark may point at; the first visible match is used at show time. */
export function markView(selector: string, name: string): void {
  if (typeof selector !== "string" || !selector.trim() || typeof name !== "string" || !name) return log("markView needs a CSS selector and a name; ignored");
  marks.set(name, selector);
}

/** The frame of the view marked `name`, or null when it is not on screen. */
function target(name: string) {
  const selector = marks.get(name);
  return selector ? findTarget(selector) : null;
}

/** Builds one event for the queue. */
export function buildEvent(messageId: string, installationId: string, type: InAppEvent["type"], at: Date, buttonId?: string): InAppEvent {
  const event: InAppEvent = { message_id: messageId, installation_id: installationId, type, at: at.toISOString() };
  if (type === "clicked" && buttonId) event.button_id = buttonId;
  return event;
}

/** Queues an event for this installation and schedules a send. */
async function record(messageId: string, type: InAppEvent["type"], buttonId?: string): Promise<void> {
  const { installation_id } = await readState();
  if (!installation_id) return log("in-app event not recorded: no installation yet");
  if ((await addEvent(buildEvent(messageId, installation_id, type, new Date(), buttonId), MAX_QUEUED)) > 0) log("in-app event queue full; dropped the oldest");
  scheduleFlush();
}

/** Adds one to this device's own shown count for a message. */
async function countShown(messageId: string): Promise<void> {
  const counts = (await get<Record<string, number>>("kv", "counts")) ?? {};
  counts[messageId] = (counts[messageId] ?? 0) + 1;
  await put("kv", "counts", counts);
}

/** Shows the first eligible cached message for the trigger; true when one went on screen. */
export async function show(trigger: { appOpen: true } | { name: string }): Promise<boolean> {
  if (onScreen || typeof window === "undefined" || typeof document === "undefined") return false;
  onScreen = true;
  try {
    const answer = await get<FetchAnswer>("kv", "answer");
    const counts = (await get<Record<string, number>>("kv", "counts")) ?? {};
    const cached = new Set(await keys("pages"));
    const message = answer && pick(answer.messages, trigger, { now: Date.now(), counts, cached, target });
    const page = message && (await get<CachedPage>("pages", cacheKey(message)));
    if (!answer || !message || !page) {
      onScreen = false;
      return false;
    }
    const html = framePage(page.html, answer.allowed_origins, {
      insets: insets(),
      target: message.format === "coach_mark" && message.coach_target ? target(message.coach_target) : null,
      light: page.light,
      posture: posture(),
    });
    showFrame(html, {
      onShown: () => void Promise.all([record(message.id, "shown"), countShown(message.id)]).catch(failed),
      onTrack: (buttonId) => void record(message.id, "clicked", buttonId).catch(failed),
      onClose: (tracked) => {
        onScreen = false;
        if (!tracked) void record(message.id, "dismissed").catch(failed);
      },
    });
    return true;
  } catch (error) {
    onScreen = false;
    failed(error);
    return false;
  }
}

/** Logs an internal failure without its details beyond the message. */
function failed(error: unknown): void {
  log(`in-app: ${(error as Error)?.message ?? error}`);
}

/** Downloads a URL with no cookies; throws on anything but 2xx. */
async function download(url: string): Promise<Response> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`download answered HTTP ${response.status}`);
  return response;
}

/** Downloads a message's page and assets and caches the page with the assets inlined. */
export async function cacheMessage(message: InAppMessage, slow: boolean): Promise<void> {
  const { url, light } = pageUrl(message, slow);
  const html = await (await download(url)).text();
  const assets: Record<string, string> = {};
  for (const asset of message.assets) {
    const response = await download(asset);
    assets[asset] = dataUri(new Uint8Array(await response.arrayBuffer()), response.headers.get("Content-Type"));
  }
  await put("pages", cacheKey(message), { html: inlineAssets(html, assets), light } satisfies CachedPage);
}

/**
 * Fetches the installation's messages if the last fetch is a minute old, drops cached pages the
 * answer no longer holds, and caches the new ones. A failed download is retried on the next fetch.
 */
export async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await readState();
    // The server knows an installation only after its first accepted sync.
    if (!state.sdk_key || !state.base_url || !state.installation_id || state.last_synced_at === undefined) return;
    if ((state.blocked_until ?? 0) > Date.now()) return;
    const age = Date.now() - ((await get<number>("kv", "fetched_at")) ?? 0);
    if (age >= 0 && age < FETCH_EVERY_MS) return;
    await put("kv", "fetched_at", Date.now());
    const reply = await request(state, "GET", "in-app", undefined, `?installation_id=${encodeURIComponent(state.installation_id)}`);
    if (reply.code !== 200) return log(`in-app fetch answered HTTP ${reply.code}`);
    const answer = parseAnswer(reply.body);
    if (!answer) return log("in-app fetch gave an unreadable answer");
    await put("kv", "answer", answer);
    const wanted = new Set(answer.messages.map(cacheKey));
    const have = await keys("pages");
    await remove("pages", have.filter((key) => !wanted.has(key)));
    const slow = isSlowDevice(navigator as Navigator & { deviceMemory?: number });
    for (const message of answer.messages) {
      if (have.includes(cacheKey(message))) continue;
      await cacheMessage(message, slow).catch((error) => log(`in-app message ${message.id} not cached yet: ${(error as Error)?.message}`));
    }
  } finally {
    refreshing = false;
  }
}

/** Sends queued events oldest first, 100 per request; returns ms until a retry is due, 0 when settled. */
export async function flushEvents(): Promise<number> {
  const state = await readState();
  if (!state.sdk_key || !state.base_url) return 0;
  const wait = (state.blocked_until ?? 0) - Date.now();
  if (wait > 0) return wait;
  for (;;) {
    const { keys: batchKeys, events } = await peekEvents(BATCH);
    if (events.length === 0) return 0;
    // A failed batch stays queued and is resent unchanged.
    if (!(await post(state, "in-app/events", JSON.stringify({ events })))) return Math.max(1, (state.blocked_until ?? 0) - Date.now());
    await deleteEvents(batchKeys);
  }
}

/** Schedules one send of queued events unless one is waiting; reschedules retries. */
function scheduleFlush(delayMs = COALESCE_MS): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    // One tab sends at a time where the browser has Web Locks.
    const run = locks ? (locks.request("pushpilot-in-app-flush", flushEvents) as unknown as Promise<number>) : flushEvents();
    run.then((wait) => wait > 0 && scheduleFlush(wait), failed);
  }, delayMs);
}

/** The page loaded or became visible: show an app_open message from cache once, then fetch and send. */
export function foreground(): void {
  if (appOpenDue) {
    appOpenDue = false;
    void show({ appOpen: true });
  }
  void refresh().catch(failed);
  scheduleFlush();
}

/** The page was hidden: the next foreground may show an app_open message again. */
export function background(): void {
  appOpenDue = true;
}

/** Clears the cache, counts and queued events, for forget(). */
export function reset(): Promise<void> {
  return clearAll();
}
