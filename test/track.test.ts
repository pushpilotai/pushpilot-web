// Custom events from track(): local checks, the /track/ body, retries with the same idempotency
// keys, batches of 100 after delivery events, holding until registered, and forget.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { advance, BASE_URL, callsTo, type Env, SDK_KEY, setup } from "./fakes";

const INSTALLATION = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AT = "2026-11-12T10:00:00.000Z";

beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: new Date(AT) }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Seeds a started SDK, registered unless `registered` is false; returns the engine, store and what is left queued. */
async function started(registered = true) {
  const store = await import("../src/store");
  const engine = await import("../src/engine");
  await store.writeState({ sdk_key: SDK_KEY, base_url: BASE_URL, installation_id: INSTALLATION, last_synced_at: registered ? Date.now() : undefined });
  const left = async () => (await store.peekEvents<{ name: string }>(10_000, store.APP_EVENT_QUEUE)).events.map((e) => e.name);
  return { engine, store, left };
}

/** Queues `count` custom events named e0, e1, ... */
async function queue(engine: typeof import("../src/engine"), count: number) {
  for (let i = 0; i < count; i++) await engine.trackAppEvent(`e${i}`, {}, AT);
}

test("an event goes to /track/ with the installation id, its properties, time and a UUID key; bad values are dropped", async () => {
  const env = setup();
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const { engine, left } = await started();
  await engine.trackAppEvent("order_placed", { value: 12.5, currency: "INR", first: true, note: null, nan: NaN, list: [1] as unknown }, AT);
  await engine.trackAppEvent("Order Placed", {}, AT);
  await engine.trackAppEvent("a".repeat(41), {}, AT);
  await engine.trackAppEvent("1st", {}, AT);
  expect(await left()).toEqual(["order_placed"]);

  expect(await engine.flush()).toBe(0);
  const [call] = callsTo(env, "track");
  expect(call.method).toBe("POST");
  expect(call.headers).toEqual({ "X-SDK-Key": SDK_KEY, "Content-Type": "application/json" });
  expect(call.body).toStrictEqual({
    installation_id: INSTALLATION,
    events: [{ name: "order_placed", properties: { value: 12.5, currency: "INR", first: true }, occurred_at: AT, idempotency_key: expect.stringMatching(UUID) }],
  });
  expect(await left()).toEqual([]);
  const logs = debug.mock.calls.map((c) => String(c[0]));
  expect(logs.filter((l) => l.includes("dropped") && l.includes("order_placed"))).toHaveLength(3);
  expect(logs.filter((l) => l.includes("ignored"))).toHaveLength(3);
});

test("each event gets its own key; a 5xx keeps the batch and the retry sends the same keys", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/track/"] = [{ status: 503 }];
  const { engine, left } = await started();
  await queue(engine, 2);

  const wait = await engine.flush();
  expect(wait).toBeGreaterThan(0);
  expect(await left()).toEqual(["e0", "e1"]);
  vi.setSystemTime(Date.now() + wait);
  expect(await engine.flush()).toBe(0);

  const [first, second] = callsTo(env, "track").map((c) => c.body.events.map((e: { idempotency_key: string }) => e.idempotency_key));
  expect(new Set(first).size).toBe(2);
  expect(second).toEqual(first);
  expect(await left()).toEqual([]);
});

test("429 and network errors keep the batch; another 4xx drops it and carries on", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/track/"] = [{ status: 429, headers: { "Retry-After": "60" } }, { status: 400, body: { detail: "bad" } }];
  const { engine, left } = await started();
  await queue(engine, 150);

  const wait = await engine.flush();
  expect(wait).toBeGreaterThanOrEqual(60_000);
  expect(await left()).toHaveLength(150);

  vi.setSystemTime(Date.now() + wait);
  env.fetchFails = true;
  const offline = await engine.flush();
  expect(offline).toBeGreaterThan(0);
  expect(await left()).toHaveLength(150);

  vi.setSystemTime(Date.now() + offline);
  env.fetchFails = false;
  expect(await engine.flush()).toBe(0);
  // The 400 dropped the first 100; the last 50 went through.
  expect(callsTo(env, "track").map((c) => c.body.events.length)).toEqual([100, 100, 50]);
  expect(await left()).toEqual([]);
});

test("custom events go in batches of 100, after delivery events", async () => {
  const env = setup();
  const { engine, left } = await started();
  await engine.track("n-1", "delivered");
  await queue(engine, 150);

  expect(await engine.flush()).toBe(0);
  const sends = env.calls.map((c) => c.path).filter((p) => p !== "/api/sdk/v1/sync/");
  expect(sends).toEqual(["/api/sdk/v1/events/", "/api/sdk/v1/track/", "/api/sdk/v1/track/"]);
  const batches = callsTo(env, "track").map((c) => c.body.events.map((e: { name: string }) => e.name));
  expect(batches.map((b) => b.length)).toEqual([100, 50]);
  expect(batches[0][0]).toBe("e0");
  expect(batches[1][0]).toBe("e100");
  expect(await left()).toEqual([]);
});

test("a delivery event that must be retried holds custom events behind it", async () => {
  const env = setup();
  env.replies["/api/sdk/v1/events/"] = [{ status: 500 }];
  const { engine, left } = await started();
  await engine.track("n-1", "delivered");
  await queue(engine, 1);
  expect(await engine.flush()).toBeGreaterThan(0);
  expect(callsTo(env, "track")).toHaveLength(0);
  expect(await left()).toEqual(["e0"]);
});

test("custom events wait while the browser is not registered", async () => {
  const env = setup();
  const { engine, left } = await started(false);
  await queue(engine, 2);
  expect(await engine.flush()).toBe(0);
  expect(callsTo(env, "track")).toHaveLength(0);
  expect(await left()).toEqual(["e0", "e1"]);
});

test("warnings in a 2xx reply are logged and the batch is removed", async () => {
  const env = setup();
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  env.replies["/api/sdk/v1/track/"] = [{ status: 200, body: { accepted: 0, warnings: ["order_placed: property value must be a number"] } }];
  const { engine, left } = await started();
  await queue(engine, 1);
  expect(await engine.flush()).toBe(0);
  expect(debug.mock.calls.map((c) => String(c[0]))).toContain('[PushPilot] track warnings: ["order_placed: property value must be a number"]');
  expect(await left()).toEqual([]);
});

test("the queue keeps the newest 1,000 custom events", async () => {
  setup();
  const { engine, left } = await started();
  await queue(engine, 1003);
  const names = await left();
  expect(names).toHaveLength(1000);
  expect(names[0]).toBe("e3");
  expect(names.at(-1)).toBe("e1002");
});

test("forget clears queued custom events", async () => {
  setup();
  const { engine, left } = await started();
  await queue(engine, 3);
  await engine.forget();
  expect(await left()).toEqual([]);
});

test("the public track() queues from the page and sends after registering", async () => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date(AT) });
  const env: Env = setup({ permission: "granted" });
  const sdk = await import("../src/index");
  sdk.track("signed_up", { plan: "pro" }); // before init: queued, then run after it
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await advance(3000);

  expect(env.calls.map((c) => c.path).filter((p) => p !== "/api/sdk/v1/web-config/")).toEqual(["/api/sdk/v1/register/", "/api/sdk/v1/track/"]);
  const [call] = callsTo(env, "track");
  expect(call.body.installation_id).toBe(callsTo(env, "register")[0].body.installation_id);
  expect(call.body.events).toEqual([{ name: "signed_up", properties: { plan: "pro" }, occurred_at: AT, idempotency_key: expect.stringMatching(UUID) }]);
});
