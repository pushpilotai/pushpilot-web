// Events queue: the same retry rules as Android. 2xx removes the batch, another 4xx drops it,
// 429/5xx/network keeps it and waits the longer of Retry-After and a jittered backoff.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BASE_URL, callsTo, type Env, SDK_KEY, setup } from "./fakes";

const INSTALLATION = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";

beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T10:00:00Z") }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Seeds a started SDK with `count` delivered events queued; returns the engine and store. */
async function queued(env: Env, count: number) {
  const store = await import("../src/store");
  const engine = await import("../src/engine");
  await store.writeState({ sdk_key: SDK_KEY, base_url: BASE_URL, installation_id: INSTALLATION });
  for (let i = 0; i < count; i++) await engine.track(`n-${i}`, "delivered");
  return { engine, store, left: async () => (await store.peekEvents(10_000)).events.map((e) => e.notification_id) };
}

test("2xx removes each batch; batches are the oldest 100 first", async () => {
  const env = setup();
  const { engine, left } = await queued(env, 150);
  expect(await engine.flush()).toBe(0);
  const posts = callsTo(env, "events");
  expect(posts.map((p) => p.body.events.length)).toEqual([100, 50]);
  expect(posts[0].body.events[0].notification_id).toBe("n-0");
  expect(posts[0].headers["X-SDK-Key"]).toBe(SDK_KEY);
  expect(await left()).toEqual([]);
});

test("another 4xx drops that batch and carries on with the next", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/events/"] = [{ status: 400, body: { detail: "bad" } }];
  const { engine, left } = await queued(env, 150);
  expect(await engine.flush()).toBe(0);
  expect(callsTo(env, "events")).toHaveLength(2);
  expect(await left()).toEqual([]);
});

test("429 keeps the batch and waits for Retry-After, then sends it", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/events/"] = [{ status: 429, headers: { "Retry-After": "120" } }];
  const { engine, left } = await queued(env, 3);
  const wait = await engine.flush();
  expect(wait).toBeGreaterThanOrEqual(120_000);
  expect(await left()).toEqual(["n-0", "n-1", "n-2"]);

  // Still blocked: no request before the wait is over.
  expect(await engine.flush()).toBeGreaterThan(0);
  expect(callsTo(env, "events")).toHaveLength(1);

  vi.setSystemTime(Date.now() + wait);
  expect(await engine.flush()).toBe(0);
  expect(callsTo(env, "events")).toHaveLength(2);
  expect(await left()).toEqual([]);
});

test("5xx and network errors keep the batch with a backoff from 1 s doubling", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/events/"] = [{ status: 503 }, { status: 500 }];
  const { engine, store, left } = await queued(env, 2);

  const first = await engine.flush();
  expect(first).toBeGreaterThanOrEqual(500);
  expect(first).toBeLessThanOrEqual(1000);
  vi.setSystemTime(Date.now() + first);
  const second = await engine.flush();
  expect(second).toBeGreaterThanOrEqual(1000);
  expect(second).toBeLessThanOrEqual(2000);

  vi.setSystemTime(Date.now() + second);
  env.fetchFails = true;
  const third = await engine.flush();
  expect(third).toBeGreaterThanOrEqual(2000);
  expect(third).toBeLessThanOrEqual(4000);
  expect(await left()).toEqual(["n-0", "n-1"]);

  vi.setSystemTime(Date.now() + third);
  env.fetchFails = false;
  expect(await engine.flush()).toBe(0);
  expect(await left()).toEqual([]);
  expect((await store.readState()).failures).toBeUndefined();
});

test("the queue keeps the newest 1,000 events", async () => {
  const env = setup();
  const { left } = await queued(env, 1003);
  const ids = await left();
  expect(ids).toHaveLength(1000);
  expect(ids[0]).toBe("n-3");
  expect(ids.at(-1)).toBe("n-1002");
});

test("a pending forget goes first, and a retryable failure holds the sync and events behind it", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/forget/"] = [{ status: 502 }];
  const { engine, store, left } = await queued(env, 1);
  await store.writeState({ pending_forget_id: "11111111-2222-4333-8444-555555555555" });
  expect(await engine.flush()).toBeGreaterThan(0);
  expect(env.calls.map((c) => c.path)).toEqual(["/api/sdk/v1/forget/"]);
  expect(await left()).toEqual(["n-0"]);
});
