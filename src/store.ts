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

/** One queued custom event from track(), as the track endpoint takes it. */
export interface AppEvent {
  name: string;
  properties: Record<string, string | number | boolean>;
  occurred_at: string;
  idempotency_key: string;
}

/** A persisted event queue: the opener of the database that holds it and its object store. */
export interface Queue {
  open: () => Promise<IDBDatabase>;
  store: string;
}

const DB_NAME = "pushpilot";
const STATE = "state";
const EVENTS = "events";

/** Returns a function that opens database `name` once per context, letting `upgrade` create its stores on first use. */
function opener(name: string, upgrade: (db: IDBDatabase) => void): () => Promise<IDBDatabase> {
  let opening: Promise<IDBDatabase> | undefined;
  return () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      opening = undefined; // let the next call try again
      throw error;
    }));
}

const db = opener(DB_NAME, (created) => {
  created.createObjectStore(STATE);
  // Events get increasing keys, so the oldest come first and appends never overwrite.
  created.createObjectStore(EVENTS, { autoIncrement: true });
});

// Custom events get a database of their own rather than a new version of "pushpilot": an older
// pushpilot-sw.js still hosted on the site opens "pushpilot" at version 1 and would then fail.
const appEventsDb = opener("pushpilot-track", (created) => created.createObjectStore(EVENTS, { autoIncrement: true }));

/** Delivery and click events, sent to /events/. */
export const DELIVERY_QUEUE: Queue = { open: db, store: EVENTS };
/** Custom events from track(), sent to /track/. */
export const APP_EVENT_QUEUE: Queue = { open: appEventsDb, store: EVENTS };

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

/** Appends an event to `queue`, dropping the oldest beyond `max`; returns how many were dropped. */
export async function addEvent(event: TrackedEvent | AppEvent, max: number, queue = DELIVERY_QUEUE): Promise<number> {
  const tx = (await queue.open()).transaction(queue.store, "readwrite");
  const store = tx.objectStore(queue.store);
  store.add(event);
  const extra = (await result(store.count())) - max;
  if (extra > 0) {
    const oldest = await result(store.getAllKeys(null, extra));
    store.delete(IDBKeyRange.bound(oldest[0], oldest[oldest.length - 1]));
  }
  await committed(tx);
  return Math.max(0, extra);
}

/** Reads the oldest `count` events of `queue` with their keys. */
export async function peekEvents<T = TrackedEvent>(count: number, queue = DELIVERY_QUEUE): Promise<{ keys: IDBValidKey[]; events: T[] }> {
  const store = (await queue.open()).transaction(queue.store).objectStore(queue.store);
  const [keys, events] = await Promise.all([result(store.getAllKeys(null, count)), result(store.getAll(null, count))]);
  return { keys, events };
}

/** Deletes the events from the first to the last of `keys` (a batch read by peekEvents). */
export async function deleteEvents(keys: IDBValidKey[], queue = DELIVERY_QUEUE): Promise<void> {
  if (keys.length === 0) return;
  const tx = (await queue.open()).transaction(queue.store, "readwrite");
  tx.objectStore(queue.store).delete(IDBKeyRange.bound(keys[0], keys[keys.length - 1]));
  await committed(tx);
}

/** Removes every event queued in `queue`. */
export async function clearEvents(queue = DELIVERY_QUEUE): Promise<void> {
  const tx = (await queue.open()).transaction(queue.store, "readwrite");
  tx.objectStore(queue.store).clear();
  await committed(tx);
}
