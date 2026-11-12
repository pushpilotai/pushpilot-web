// Page SDK: subscribe flow, replacing another server key's subscription, permission, the
// register body, coalesced syncs, unsubscribe and forget.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { advance, BASE_URL, callsTo, FakeSubscription, keyBytes, ONESIGNAL_KEY, SDK_KEY, setup } from "./fakes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Imports the page SDK fresh, as a new page load does. */
const load = () => import("../src/index");

test("subscribe asks permission, fetches the server key, subscribes and registers exactly as the contract says", async () => {
  const env = setup();
  const sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: `${BASE_URL}/` });
  await advance(3000);
  // No push address yet, so nothing is registered.
  expect(env.calls).toEqual([]);

  expect(await sdk.subscribe()).toBe(true);
  await advance(100);

  expect(env.Notification.requestPermission).toHaveBeenCalledOnce();
  expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/pushpilot-sw.js");
  const [config] = callsTo(env, "web-config");
  expect(config).toMatchObject({ method: "GET", headers: { "X-SDK-Key": SDK_KEY }, body: undefined });
  expect(env.pushManager.subscribeCalls).toHaveLength(1);
  expect(env.pushManager.subscribeCalls[0].userVisibleOnly).toBe(true);
  expect([...env.pushManager.subscribeCalls[0].applicationServerKey]).toEqual([...keyBytes(1)]);

  const registers = callsTo(env, "register");
  expect(registers).toHaveLength(1);
  expect(registers[0].method).toBe("POST");
  expect(registers[0].headers).toEqual({ "X-SDK-Key": SDK_KEY, "Content-Type": "application/json" });
  expect(registers[0].body).toStrictEqual({
    installation_id: expect.stringMatching(UUID),
    token_kind: "webpush",
    web_push: { endpoint: "https://fcm.googleapis.com/fcm/send/sub1", p256dh: "p256dh-1", auth: "auth-1" },
    external_user_id: null,
    notification_permission: "granted",
    sdk_version: "0.0.0-test",
    device_model: "Chrome 131",
    locale: "en-GB",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  // Nothing left over: one register, no sync.
  await advance(5000);
  expect(callsTo(env, "sync")).toHaveLength(0);
});

test("a subscription made with another server key is replaced on the next visit without a prompt", async () => {
  const env = setup({ permission: "granted" });
  const oneSignal = new FakeSubscription("https://fcm.googleapis.com/fcm/send/onesignal", ONESIGNAL_KEY, env.pushManager);
  env.pushManager.current = oneSignal;
  const sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await advance(3000);

  expect(env.Notification.requestPermission).not.toHaveBeenCalled();
  expect(oneSignal.unsubscribed).toBe(true);
  expect([...env.pushManager.subscribeCalls[0].applicationServerKey]).toEqual([...keyBytes(1)]);
  expect(callsTo(env, "register")[0].body.web_push.endpoint).toBe("https://fcm.googleapis.com/fcm/send/sub1");
});

test("a subscription already made with our key is kept", async () => {
  const env = setup({ permission: "granted" });
  const ours = new FakeSubscription("https://fcm.googleapis.com/fcm/send/ours", keyBytes(1), env.pushManager);
  env.pushManager.current = ours;
  const sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await advance(3000);

  expect(ours.unsubscribed).toBe(false);
  expect(env.pushManager.subscribeCalls).toHaveLength(0);
  expect(callsTo(env, "register")[0].body.web_push.endpoint).toBe("https://fcm.googleapis.com/fcm/send/ours");
});

test("permission denied: subscribe resolves false and nothing is subscribed or registered", async () => {
  const env = setup({ answer: "denied" });
  const sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  expect(await sdk.subscribe()).toBe(false);
  await advance(3000);

  expect(env.Notification.requestPermission).toHaveBeenCalledOnce();
  expect(env.pushManager.subscribeCalls).toHaveLength(0);
  expect(env.calls).toEqual([]);
});

test("permission withdrawn later clears the address and reports denied when the page is next shown", async () => {
  const env = setup();
  const sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await sdk.subscribe();
  await advance(3000);

  env.Notification.permission = "denied";
  env.listeners["document:visibilitychange"]({});
  await advance(3000);

  const [sync] = callsTo(env, "sync");
  expect(sync.body).toMatchObject({ web_push: null, notification_permission: "denied", token_kind: "webpush" });
});

test("calls before init are queued, and rapid changes share one sync with validated values", async () => {
  const env = setup();
  const sdk = await load();
  sdk.setExternalUserId("  user_42 ");
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await sdk.subscribe();
  await advance(3000);
  expect(callsTo(env, "register")[0].body.external_user_id).toBe("user_42");

  sdk.setTopics(["news", "bad topic!", "alerts", "news"]);
  sdk.setAttributes({ plan: "pro", score: 3, broken: Number.NaN });
  sdk.setAttributes({ vip: true, plan: null });
  await advance(3000);

  const syncs = callsTo(env, "sync");
  expect(syncs).toHaveLength(1);
  expect(syncs[0].body.topics).toEqual(["alerts", "news"]);
  expect(syncs[0].body.attributes).toEqual({ plan: null, score: 3, vip: true });

  sdk.logout();
  await advance(3000);
  expect(callsTo(env, "sync")[1].body.external_user_id).toBeNull();
});

test("unsubscribe removes the subscription, clears the address and stays off on the next visit", async () => {
  const env = setup();
  let sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await sdk.subscribe();
  await advance(3000);
  const subscription = env.pushManager.current!;

  await sdk.unsubscribe();
  await advance(100);
  expect(subscription.unsubscribed).toBe(true);
  expect(callsTo(env, "sync")[0].body.web_push).toBeNull();

  vi.resetModules();
  sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await advance(3000);
  expect(env.pushManager.subscribeCalls).toHaveLength(1);

  expect(await sdk.subscribe()).toBe(true);
  await advance(100);
  expect(callsTo(env, "sync").at(-1)!.body.web_push.endpoint).toBe("https://fcm.googleapis.com/fcm/send/sub2");
});

test("forget deletes the installation on the server and starts a new one", async () => {
  const env = setup();
  const sdk = await load();
  sdk.init(SDK_KEY, { baseUrl: BASE_URL });
  await sdk.subscribe();
  await advance(3000);
  const oldId = callsTo(env, "register")[0].body.installation_id;

  sdk.forget();
  await advance(100);
  expect(callsTo(env, "forget")[0].body).toEqual({ installation_id: oldId });
  // Nothing registers again until the next page load picks up the subscription.
  await advance(3000);
  expect(callsTo(env, "register")).toHaveLength(1);

  vi.resetModules();
  (await load()).init(SDK_KEY, { baseUrl: BASE_URL });
  await advance(3000);
  const again = callsTo(env, "register")[1].body;
  expect(again.installation_id).toMatch(UUID);
  expect(again.installation_id).not.toBe(oldId);
  expect(again.web_push).not.toBeNull();
});

test("the default base URL is the hosted server", async () => {
  setup();
  const sdk = await load();
  expect(sdk.DEFAULT_BASE_URL).toBe("https://pushpilot.ai");
});
