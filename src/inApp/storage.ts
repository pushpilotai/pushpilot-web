// IndexedDB storage for in-app messages, in a database of its own ("pushpilot-in-app") so the
// shared "pushpilot" database, which the service worker also opens, keeps its version.
// Stores: "kv" (the last fetch answer, local shown counts, last fetch time), "pages" (cached pages
// by message id and HTML version) and "events" (the queue for /in-app/events/).
import { committed, result } from "../store";

/** One queued in-app event, as `POST /api/sdk/v1/in-app/events/` takes it. */
export interface InAppEvent {
  message_id: string;
  installation_id: string;
  type: "shown" | "clicked" | "dismissed";
  at: string;
  button_id?: string;
}

/** A cached page with its assets inlined. */
export interface CachedPage {
  html: string;
  light: boolean;
}

type StoreName = "kv" | "pages" | "events";

let opening: Promise<IDBDatabase> | undefined;

/** Opens the database once per page, creating its stores on first use. */
function db(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pushpilot-in-app", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("kv");
      request.result.createObjectStore("pages");
      request.result.createObjectStore("events", { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    opening = undefined; // let the next call try again
    throw error;
  });
  return opening;
}

/** Reads one value. */
export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  return result((await db()).transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

/** Writes one value. */
export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  const tx = (await db()).transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await committed(tx);
}

/** Every key in a store. */
export async function keys(store: StoreName): Promise<string[]> {
  return (await result((await db()).transaction(store).objectStore(store).getAllKeys())).map(String);
}

/** Deletes the given keys from a store. */
export async function remove(store: StoreName, list: string[]): Promise<void> {
  if (list.length === 0) return;
  const tx = (await db()).transaction(store, "readwrite");
  for (const key of list) tx.objectStore(store).delete(key);
  await committed(tx);
}

/** Appends an event, dropping the oldest beyond `max`; returns how many were dropped. */
export async function addEvent(event: InAppEvent, max: number): Promise<number> {
  const tx = (await db()).transaction("events", "readwrite");
  const store = tx.objectStore("events");
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
export async function peekEvents(count: number): Promise<{ keys: IDBValidKey[]; events: InAppEvent[] }> {
  const store = (await db()).transaction("events").objectStore("events");
  const [list, events] = await Promise.all([result(store.getAllKeys(null, count)), result(store.getAll(null, count))]);
  return { keys: list, events };
}

/** Deletes the events from the first to the last of `list` (a batch read by peekEvents). */
export async function deleteEvents(list: IDBValidKey[]): Promise<void> {
  if (list.length === 0) return;
  const tx = (await db()).transaction("events", "readwrite");
  tx.objectStore("events").delete(IDBKeyRange.bound(list[0], list[list.length - 1]));
  await committed(tx);
}

/** Empties every store, for forget(). */
export async function clearAll(): Promise<void> {
  const tx = (await db()).transaction(["kv", "pages", "events"], "readwrite");
  for (const name of ["kv", "pages", "events"]) tx.objectStore(name).clear();
  await committed(tx);
}
