// IndexedDB storage shared by the page SDK and the service worker (same origin, same database).

/** A browser push address in the shape the server's `web_push` field takes. */
export interface WebPush {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Attribute values the server accepts; null removes the attribute. */
export type AttributeValue = string | number | boolean | null;

/** Everything the SDK keeps; a missing key means "never set" or "cleared". */
export interface State {
  sdk_key?: string;
  base_url?: string;
  installation_id?: string;
  web_push?: WebPush;
  external_user_id?: string;
  topics?: string[];
  attributes?: Record<string, AttributeValue>;
  last_sent_payload?: string;
  last_synced_at?: number;
  pending_forget_id?: string;
  blocked_until?: number;
  failures?: number;
  vapid_public_key?: string;
  vapid_fetched_at?: number;
  opted_out?: boolean;
}

/** One queued tracking event, as the events endpoint takes it. */
export interface TrackedEvent {
  notification_id: string;
  installation_id: string;
  type: "delivered" | "clicked";
  at: string;
  button_id?: string;
}

const DB_NAME = "pushpilot";
const STATE = "state";
const EVENTS = "events";

let opening: Promise<IDBDatabase> | undefined;

/** Opens the database once per context, creating its two stores on first use. */
function db(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STATE);
      // Events get increasing keys, so the oldest come first and appends never overwrite.
      request.result.createObjectStore(EVENTS, { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    opening = undefined; // let the next call try again
    throw error;
  });
  return opening;
}

/** Resolves with a request's result. */
export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves once a write transaction is committed. */
export function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Reads every stored value into one object. */
export async function readState(): Promise<State> {
  const store = (await db()).transaction(STATE).objectStore(STATE);
  const [keys, values] = await Promise.all([result(store.getAllKeys()), result(store.getAll())]);
  const state: Record<string, unknown> = {};
  keys.forEach((key, i) => (state[String(key)] = values[i]));
  return state as State;
}

/** Writes all given keys in one transaction; undefined removes a key. */
export async function writeState(patch: Partial<State>): Promise<void> {
  const tx = (await db()).transaction(STATE, "readwrite");
  const store = tx.objectStore(STATE);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) store.delete(key);
    else store.put(value, key);
  }
  await committed(tx);
}

/** Appends an event, dropping the oldest beyond `max`; returns how many were dropped. */
export async function addEvent(event: TrackedEvent, max: number): Promise<number> {
  const tx = (await db()).transaction(EVENTS, "readwrite");
  const store = tx.objectStore(EVENTS);
  store.add(event);
  const extra = (await result(store.count())) - max;
  if (extra > 0) {
    const oldest = await result(store.getAllKeys(null, extra));
    store.delete(IDBKeyRange.bound(oldest[0], oldest[oldest.length - 1]));
  }
  await committed(tx);
  return Math.max(0, extra);
}

/** Reads the oldest `count` events with their keys. */
export async function peekEvents(count: number): Promise<{ keys: IDBValidKey[]; events: TrackedEvent[] }> {
  const store = (await db()).transaction(EVENTS).objectStore(EVENTS);
  const [keys, events] = await Promise.all([result(store.getAllKeys(null, count)), result(store.getAll(null, count))]);
  return { keys, events };
}

/** Deletes the events from the first to the last of `keys` (a batch read by peekEvents). */
export async function deleteEvents(keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  const tx = (await db()).transaction(EVENTS, "readwrite");
  tx.objectStore(EVENTS).delete(IDBKeyRange.bound(keys[0], keys[keys.length - 1]));
  await committed(tx);
}

/** Removes every queued event. */
export async function clearEvents(): Promise<void> {
  const tx = (await db()).transaction(EVENTS, "readwrite");
  tx.objectStore(EVENTS).clear();
  await committed(tx);
}
