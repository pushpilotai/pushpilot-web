// PushPilot web SDK, page side. Every setter returns at once and never throws; storage and network
// work run one call at a time, in order. Calls made before init are queued and run after it.
import { ensureSubscription, flush, forget as resetInstallation, log, permission, stale } from "./engine";
import { readState, writeState, type AttributeValue, type State } from "./store";

export type { AttributeValue };

/** PushPilot's hosted server; pass another `baseUrl` to init for a self-hosted one. */
export const DEFAULT_BASE_URL = "https://pushpilot.ai";

/** Options for {@link init}. */
export interface InitOptions {
  /** Server to talk to; defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Path of the service worker file on this site; defaults to `/pushpilot-sw.js`. */
  serviceWorkerPath?: string;
}

const COALESCE_MS = 2_000;
const MAX_TOPICS = 100;
/** The character set the server accepts for topic names. */
const TOPIC = /^[A-Za-z0-9._~%-]+$/;

let workerPath = "/pushpilot-sw.js";
let started = false;
let chain: Promise<unknown> = Promise.resolve();
const queued: (() => Promise<void>)[] = [];
let scheduled = false;

/** True when this browser can receive web push here (on iOS, only from a site added to the Home Screen). */
export function isSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined" &&
    typeof indexedDB !== "undefined"
  );
}

/** Starts the SDK with the app's public SDK key. Safe to call more than once; later calls are ignored. */
export function init(sdkKey: string, options: InitOptions = {}): void {
  if (started) return log("init already called; ignored");
  const key = typeof sdkKey === "string" ? sdkKey.trim() : "";
  if (!key) return log("init ignored: the SDK key is empty");
  if (!isSupported()) return log("this browser does not support web push here; init ignored");
  started = true;
  workerPath = options.serviceWorkerPath ?? workerPath;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  run(() => start(key, baseUrl), undefined);
  for (const call of queued.splice(0)) run(call, undefined);
  if (typeof document !== "undefined") {
    // The page coming back into view is the web's "app foreground": permission may have changed.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") submit(foreground);
    });
  }
}

/** Links this browser to the site's own user id after login; null clears it. */
export function setExternalUserId(id: string | null): void {
  const clean = typeof id === "string" ? id.trim() : "";
  if (clean.length > 255) return log("external user id is longer than 255 characters; ignored");
  update({ external_user_id: clean || undefined });
}

/** Merges attributes declared in the dashboard; values are string, number, boolean, or null to remove. */
export function setAttributes(attributes: Record<string, AttributeValue>): void {
  const copy = { ...attributes };
  submit(async () => {
    const current = { ...(await readState()).attributes };
    for (const [name, value] of Object.entries(copy)) {
      const ok = value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
      if (ok) current[name] = value;
      else log(`attribute ${name} must be a string, finite number or boolean; ignored`);
    }
    await writeState({ attributes: current });
    kick();
  });
}

/** Replaces this browser's topic list; names the server would reject are dropped so they cannot fail the sync. */
export function setTopics(topics: string[]): void {
  const valid = topics.filter((t) => typeof t === "string" && t.length <= 255 && TOPIC.test(t));
  if (valid.length < topics.length) log(`${topics.length - valid.length} invalid topic names ignored`);
  const unique = [...new Set(valid)].sort();
  if (unique.length > MAX_TOPICS) log(`only the first ${MAX_TOPICS} topics are kept`);
  update({ topics: unique.slice(0, MAX_TOPICS) });
}

/** Clears the external user id; the browser stays registered and keeps receiving pushes. */
export function logout(): void {
  setExternalUserId(null);
}

/** Deletes this installation from PushPilot and clears local state; the next page load registers a new one. */
export function forget(): void {
  submit(async () => {
    await resetInstallation();
    kick(0);
  });
}

/**
 * Asks for notification permission if it was never asked, then subscribes this browser and
 * registers it. Call it from a click: browsers show the prompt only for a user gesture.
 * Resolves true when subscribed; false when permission was not granted or something failed.
 */
export async function subscribe(): Promise<boolean> {
  if (!started) {
    log("call init before subscribe");
    return false;
  }
  // Asked before anything else is awaited, so the browser still counts the visitor's click.
  const answer = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  return run(async () => {
    if (answer !== "granted") {
      log(`notification permission is ${answer}; not subscribed`);
      await writeState({ web_push: undefined });
      kick();
      return false;
    }
    await writeState({ opted_out: undefined });
    await subscribeWorker(await readState());
    kick(0);
    return true;
  }, false);
}

/** Removes this browser's push subscription and clears its address; it stays unsubscribed until subscribe(). */
export function unsubscribe(): Promise<void> {
  if (!started) return Promise.resolve(log("call init before unsubscribe"));
  return run(async () => {
    const registration = await navigator.serviceWorker.getRegistration(workerPath);
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    await writeState({ web_push: undefined, opted_out: true });
    kick(0);
  }, undefined);
}

/** Stores the key and base URL for the worker, creates the installation id once, and picks up the subscription. */
async function start(sdkKey: string, baseUrl: string): Promise<void> {
  const state = await readState();
  await writeState({
    sdk_key: sdkKey,
    base_url: baseUrl,
    installation_id: state.installation_id ?? crypto.randomUUID(),
    // No accepted sync in a day: send everything again.
    last_sent_payload: stale(state) ? undefined : state.last_sent_payload,
  });
  await refresh();
  kick();
}

/** On the page becoming visible: resync if the last sync is a day old, and pick up permission changes. */
async function foreground(): Promise<void> {
  const state = await readState();
  if (state.last_synced_at !== undefined && stale(state)) await writeState({ last_sent_payload: undefined });
  await refresh();
  kick();
}

/**
 * Matches the stored address to the browser: cleared without permission, and with permission
 * (unless the visitor unsubscribed) subscribed with this app's key without a prompt.
 */
async function refresh(): Promise<void> {
  const state = await readState();
  if (permission() !== "granted") {
    if (state.web_push) await writeState({ web_push: undefined });
    return;
  }
  if (state.opted_out) return;
  try {
    await subscribeWorker(state);
  } catch (error) {
    log(`subscription not refreshed: ${(error as Error)?.message}`);
  }
}

/** Registers the service worker, waits for it to be active, and subscribes with this app's key. */
async function subscribeWorker(state: State): Promise<void> {
  const registration = await navigator.serviceWorker.register(workerPath);
  await activated(registration);
  await ensureSubscription(registration, state);
}

/** Resolves once the registration has an active worker, which subscribing requires. */
function activated(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active) return Promise.resolve();
  const worker = registration.installing ?? registration.waiting;
  if (!worker) return Promise.reject(new Error("the service worker did not install"));
  return new Promise((resolve, reject) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
      if (worker.state === "redundant") reject(new Error("the service worker failed to install"));
    });
  });
}

/** Writes state and schedules a sync. */
function update(patch: Partial<State>): void {
  submit(async () => {
    await writeState(patch);
    kick();
  });
}

/** Runs `call` after init and every earlier call; before init, queues it (at most 100). */
function submit(call: () => Promise<void>): void {
  if (started) return void run(call, undefined);
  // Bounded so a site that never calls init cannot grow this forever.
  if (queued.length < 100) queued.push(call);
  log("PushPilot.init has not been called yet; the call is queued");
}

/** Chains `call` after every earlier call; a failure is logged and resolves to `fallback`. */
function run<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  const next = chain.then(call).catch((error) => {
    log(`internal error: ${(error as Error)?.message ?? error}`);
    return fallback;
  });
  chain = next;
  return next;
}

/** Schedules one flush unless one is waiting, so rapid changes share one request; reschedules retries. */
function kick(delayMs = COALESCE_MS): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    flush().then(
      (wait) => wait > 0 && kick(wait),
      (error) => log(`flush failed: ${(error as Error)?.message ?? error}`),
    );
  }, delayMs);
}
