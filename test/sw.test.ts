// Service worker: push handling, click routing, delivered/clicked events, pushsubscriptionchange.
import { afterEach, expect, test, vi } from "vitest";
import { BASE_URL, callsTo, type Env, FakeSubscription, keyBytes, pushData, SCOPE, SDK_KEY, setup, swEvent } from "./fakes";

const INSTALLATION = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
const NOTIFICATION = "0b7c6d5e-4f3a-4b2c-9d1e-0f1234567890";
const PUSH = {
  source: "pushpilot",
  notification_id: NOTIFICATION,
  title: "नमस्ते",
  body: "Your order has shipped",
  image_url: "https://shop.test/a.png",
  url: "https://shop.test/orders/42",
  data: { order_id: "42" },
  buttons: [
    { id: "track", label: "Track", url: "https://shop.test/orders/42/track" },
    { id: "later", label: "Later" },
    { id: "help", label: "Help", url: "https://shop.test/help" },
  ],
};

afterEach(() => vi.unstubAllGlobals());

/** Seeds what the page SDK stores, then loads the worker. */
async function worker(env: Env, state: Record<string, unknown> = {}) {
  const store = await import("../src/store");
  await store.writeState({ sdk_key: SDK_KEY, base_url: BASE_URL, installation_id: INSTALLATION, ...state });
  await import("../src/sw");
  return env;
}

/** Dispatches a push and waits for the worker to finish with it. */
async function push(env: Env, data: unknown) {
  const event = swEvent({ data: data === null ? null : pushData(data) });
  env.listeners.push(event);
  await event.done();
  return event;
}

/** Dispatches a click on the notification the worker showed last. */
async function click(env: Env, action = "") {
  const notification = { data: env.shown.at(-1)!.options.data, close: vi.fn() };
  const event = swEvent({ notification, action });
  env.listeners.notificationclick(event);
  await event.done();
  return notification;
}

test("a PushPilot push is shown with title, body, image, data and buttons capped by the browser, and delivery is reported", async () => {
  const env = await worker(setup({ permission: "granted" }));
  await push(env, PUSH);

  expect(env.shown).toHaveLength(1);
  const { title, options } = env.shown[0];
  expect(title).toBe("नमस्ते");
  expect(options).toMatchObject({ body: "Your order has shipped", image: "https://shop.test/a.png", tag: NOTIFICATION, data: { pushpilot: PUSH } });
  expect(options.actions).toEqual([
    { action: "track", title: "Track" },
    { action: "later", title: "Later" },
  ]);
  const [events] = callsTo(env, "events");
  expect(events.body.events).toEqual([{ notification_id: NOTIFICATION, installation_id: INSTALLATION, type: "delivered", at: expect.any(String) }]);
  expect(new Date(events.body.events[0].at).toISOString()).toBe(events.body.events[0].at);
});

test("buttons are left out where the browser has no Notification.maxActions, and never more than three", async () => {
  const env = setup({ permission: "granted" });
  env.Notification.maxActions = undefined;
  await worker(env);
  await push(env, PUSH);
  expect(env.shown[0].options.actions).toEqual([]);

  env.Notification.maxActions = 10;
  await push(env, { ...PUSH, buttons: [...PUSH.buttons, { id: "four", label: "Four" }] });
  expect(env.shown[1].options.actions.map((a: { action: string }) => a.action)).toEqual(["track", "later", "help"]);
});

test("pushes that are not PushPilot's are ignored", async () => {
  const env = await worker(setup({ permission: "granted" }));
  for (const data of [{ source: "onesignal", title: "x", notification_id: NOTIFICATION }, "not json", null, { title: "no source" }]) {
    const event = await push(env, data);
    expect(event.pending).toHaveLength(0);
  }
  // Ours but without a title: not shown either.
  await push(env, { source: "pushpilot", notification_id: NOTIFICATION });
  expect(env.shown).toHaveLength(0);
  expect(env.calls).toHaveLength(0);
});

test("a click on the body opens the push's url and reports clicked without a button", async () => {
  const env = await worker(setup({ permission: "granted" }));
  await push(env, PUSH);
  const notification = await click(env);

  expect(notification.close).toHaveBeenCalled();
  expect(env.opened).toEqual(["https://shop.test/orders/42"]);
  const clicked = callsTo(env, "events").flatMap((c) => c.body.events).filter((e) => e.type === "clicked");
  expect(clicked).toEqual([{ notification_id: NOTIFICATION, installation_id: INSTALLATION, type: "clicked", at: expect.any(String) }]);
});

test("a body click focuses a window already showing the link, and opens the site when the push has no url", async () => {
  const env = await worker(setup({ permission: "granted" }));
  const focus = vi.fn(async () => {});
  env.windows.push({ url: "https://shop.test/orders/42", focus });
  await push(env, PUSH);
  await click(env);
  expect(focus).toHaveBeenCalled();
  expect(env.opened).toEqual([]);

  await push(env, { ...PUSH, url: undefined });
  await click(env);
  expect(env.opened).toEqual([SCOPE]);
});

test("a button with a link opens it, a button without one only dismisses, and both report the button id", async () => {
  const env = await worker(setup({ permission: "granted" }));
  await push(env, PUSH);
  await click(env, "track");
  expect(env.opened).toEqual(["https://shop.test/orders/42/track"]);

  const notification = await click(env, "later");
  expect(notification.close).toHaveBeenCalled();
  expect(env.opened).toEqual(["https://shop.test/orders/42/track"]);

  const clicked = callsTo(env, "events").flatMap((c) => c.body.events).filter((e) => e.type === "clicked");
  expect(clicked.map((e) => e.button_id)).toEqual(["track", "later"]);
});

test("a click on someone else's notification is left alone", async () => {
  const env = await worker(setup({ permission: "granted" }));
  const notification = { data: { theirs: true }, close: vi.fn() };
  const event = swEvent({ notification, action: "" });
  env.listeners.notificationclick(event);
  expect(event.pending).toHaveLength(0);
  expect(notification.close).not.toHaveBeenCalled();
});

test("pushsubscriptionchange subscribes again with our key and syncs the new address", async () => {
  const env = setup({ permission: "granted" });
  await worker(env, {
    web_push: { endpoint: "https://fcm.googleapis.com/fcm/send/old", p256dh: "p", auth: "a" },
    last_synced_at: Date.now(),
    last_sent_payload: "{}",
  });
  // The browser dropped the old subscription.
  env.pushManager.current = null;
  const event = swEvent({});
  env.listeners.pushsubscriptionchange(event);
  await event.done();

  expect([...env.pushManager.subscribeCalls[0].applicationServerKey]).toEqual([...keyBytes(1)]);
  const [sync] = callsTo(env, "sync");
  expect(sync.body).toMatchObject({
    installation_id: INSTALLATION,
    token_kind: "webpush",
    web_push: { endpoint: "https://fcm.googleapis.com/fcm/send/sub1", p256dh: "p256dh-1", auth: "auth-1" },
  });
});

test("pushsubscriptionchange keeps a new subscription the browser already made with our key", async () => {
  const env = setup({ permission: "granted" });
  await worker(env, { last_synced_at: Date.now() });
  env.pushManager.current = new FakeSubscription("https://fcm.googleapis.com/fcm/send/rotated", keyBytes(1), env.pushManager);
  const event = swEvent({});
  env.listeners.pushsubscriptionchange(event);
  await event.done();

  expect(env.pushManager.subscribeCalls).toHaveLength(0);
  expect(callsTo(env, "sync")[0].body.web_push.endpoint).toBe("https://fcm.googleapis.com/fcm/send/rotated");
});

test("pushsubscriptionchange does nothing after the visitor unsubscribed", async () => {
  const env = setup({ permission: "granted" });
  await worker(env, { opted_out: true, last_synced_at: Date.now() });
  const event = swEvent({});
  env.listeners.pushsubscriptionchange(event);
  await event.done();
  expect(env.pushManager.subscribeCalls).toHaveLength(0);
  expect(env.calls).toHaveLength(0);
});

test("as the site's whole worker it takes over at once; imported into another worker it does not", async () => {
  let env = setup();
  await worker(env);
  expect(env.listeners.install).toBeDefined();

  env = setup();
  (self as unknown as { location: URL }).location = new URL(`${SCOPE}sw.js`);
  await worker(env);
  expect(env.listeners.install).toBeUndefined();
});
