// @vitest-environment jsdom
// In-app messages end to end against a scripted server: the fetch and its once-a-minute limit,
// caching with assets inlined, showInApp and app_open, the cap, coach marks, and the events queue.
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { advance, BASE_URL, SDK_KEY } from "./fakes";
import { message } from "./inAppFakes";

const INSTALLATION = "6f1c2d3e-4b5a-4c6d-8e7f-901234567890";
const PAGE = `<!doctype html><html><head><title>x</title></head><body><img src="https://cdn.test/hero.png"></body></html>`;

/** Requests the fake network received. */
let calls: { url: string; method: string; headers: Record<string, string>; body: any }[];
/** Scripted answers by URL; the default fetch answer and event answers come from `answer`/`eventsStatus`. */
let files: Record<string, { body: BodyInit; type: string; status?: number }>;
let answer: unknown;
let eventsStatus: number[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-11-19T12:00:00Z") });
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  calls = [];
  eventsStatus = [];
  answer = { messages: [], allowed_origins: [] };
  files = {
    "https://cdn.test/v3.html": { body: PAGE, type: "text/html" },
    "https://cdn.test/v3.light.html": { body: PAGE.replace("<title>x", "<title>light"), type: "text/html" },
    "https://cdn.test/hero.png": { body: new Uint8Array([1, 2, 3]), type: "image/png" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", headers: { ...(init.headers as Record<string, string>) }, body: init.body && JSON.parse(init.body as string) });
      if (url.startsWith(`${BASE_URL}/api/sdk/v1/in-app/events/`)) return new Response("{}", { status: eventsStatus.shift() ?? 200 });
      if (url.startsWith(`${BASE_URL}/api/sdk/v1/in-app/`)) return new Response(JSON.stringify(answer), { status: 200 });
      const file = files[url];
      return file ? new Response(file.body, { status: file.status ?? 200, headers: { "Content-Type": file.type } }) : new Response("", { status: 404 });
    }),
  );
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fresh in-app module and store over a started SDK state; `synced` false means never synced. */
async function load(synced = true) {
  const store = await import("../src/store");
  await store.writeState({ sdk_key: SDK_KEY, base_url: BASE_URL, installation_id: INSTALLATION, ...(synced ? { last_synced_at: Date.now() } : {}) });
  const inApp = await import("../src/inApp");
  const storage = await import("../src/inApp/storage");
  return { inApp, storage, store };
}

/** The message iframe on the page, if any. */
const frame = () => document.querySelector<HTMLIFrameElement>("iframe[sandbox]");

/** Sends a bridge call from the message's iframe, then lets storage settle. */
async function bridge(type: string, value?: string) {
  window.dispatchEvent(new MessageEvent("message", { data: { pushpilot: JSON.stringify({ type, value }) }, source: frame()!.contentWindow }));
  await advance(0);
}

/** Every event body POSTed to the in-app events route. */
const posted = () => calls.filter((c) => c.url.endsWith("/in-app/events/")).flatMap((c) => c.body.events);

test("the fetch waits for the first sync, sends the key and installation id, and runs at most once a minute", async () => {
  let { inApp } = await load(false);
  await inApp.refresh();
  expect(calls).toEqual([]);

  ({ inApp } = await load(true));
  await inApp.refresh();
  await inApp.refresh();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ url: `${BASE_URL}/api/sdk/v1/in-app/?installation_id=${INSTALLATION}`, method: "GET", headers: { "X-SDK-Key": SDK_KEY } });
  vi.setSystemTime(Date.now() + 59_000);
  await inApp.refresh();
  expect(calls).toHaveLength(1);
  vi.setSystemTime(Date.now() + 2_000);
  await inApp.refresh();
  expect(calls).toHaveLength(2);
});

test("pages are cached by id and version with assets inlined; a new version replaces the old and a dropped message leaves", async () => {
  const { inApp, storage } = await load();
  answer = { messages: [message()], allowed_origins: [] };
  await inApp.refresh();
  expect(await storage.keys("pages")).toEqual([`${message().id}:3`]);
  const page = await storage.get<{ html: string; light: boolean }>("pages", `${message().id}:3`);
  expect(page).toEqual({ html: PAGE.replace("https://cdn.test/hero.png", "data:image/png;base64,AQID"), light: false });
  expect(calls.filter((c) => c.url.startsWith("https://cdn.test/")).every((c) => c.method === "GET")).toBe(true);

  answer = { messages: [message({ html_version: 4 })], allowed_origins: [] };
  vi.setSystemTime(Date.now() + 61_000);
  await inApp.refresh();
  expect(await storage.keys("pages")).toEqual([`${message().id}:4`]);

  answer = { messages: [], allowed_origins: [] };
  vi.setSystemTime(Date.now() + 61_000);
  await inApp.refresh();
  expect(await storage.keys("pages")).toEqual([]);
});

test("a slow device caches the light page, and a failed download is retried on the next fetch", async () => {
  Object.defineProperty(navigator, "deviceMemory", { value: 2, configurable: true });
  const { inApp, storage } = await load();
  answer = { messages: [message()], allowed_origins: [] };
  files["https://cdn.test/hero.png"].status = 500;
  await inApp.refresh();
  expect(await storage.keys("pages")).toEqual([]);

  files["https://cdn.test/hero.png"].status = 200;
  vi.setSystemTime(Date.now() + 61_000);
  await inApp.refresh();
  const page = await storage.get<{ html: string; light: boolean }>("pages", `${message().id}:3`);
  expect(page?.light).toBe(true);
  expect(page?.html).toContain("<title>light");
  delete (navigator as { deviceMemory?: unknown }).deviceMemory;
});

test("showInApp shows the named message in the locked-down frame with CSP and bridge, and records shown then clicked", async () => {
  const { inApp, storage } = await load();
  const checkout = message({ trigger: "show_in_app", trigger_name: "checkout" });
  answer = { messages: [checkout], allowed_origins: ["https://api.example.com"] };
  await inApp.refresh();

  expect(await inApp.show({ name: "cart" })).toBe(false);
  expect(await inApp.show({ name: "checkout" })).toBe(true);
  const srcdoc = frame()!.getAttribute("srcdoc")!;
  expect(srcdoc.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy"`)).toBe(true);
  expect(srcdoc).toContain("connect-src https://api.example.com\">");
  expect(srcdoc).toContain("window.pushpilot=");
  expect(srcdoc).toContain('"light":false');
  expect(srcdoc).toContain("data:image/png;base64,AQID");
  expect(srcdoc).not.toContain("https://cdn.test/hero.png");
  // Never two at once.
  expect(await inApp.show({ name: "checkout" })).toBe(false);
  expect(document.querySelectorAll("iframe")).toHaveLength(1);

  frame()!.dispatchEvent(new Event("load"));
  await advance(0);
  await bridge("track", "buy");
  await bridge("close");
  expect(frame()).toBeNull();
  expect(await storage.get("kv", "counts")).toEqual({ [checkout.id]: 1 });

  await advance(2_000);
  expect(posted()).toEqual([
    { message_id: checkout.id, installation_id: INSTALLATION, type: "shown", at: "2026-11-19T12:00:00.000Z" },
    { message_id: checkout.id, installation_id: INSTALLATION, type: "clicked", button_id: "buy", at: "2026-11-19T12:00:00.000Z" },
  ]);
  expect(calls.find((c) => c.url.endsWith("/in-app/events/"))).toMatchObject({ method: "POST", headers: { "X-SDK-Key": SDK_KEY, "Content-Type": "application/json" } });
});

test("a showing closed without track is dismissed; the local count holds the cap; a failed batch is resent unchanged", async () => {
  const { inApp } = await load();
  const once = message({ trigger: "show_in_app", trigger_name: "promo", cap_per_device: 1 });
  answer = { messages: [once], allowed_origins: [] };
  await inApp.refresh();

  expect(await inApp.show({ name: "promo" })).toBe(true);
  frame()!.dispatchEvent(new Event("load"));
  await advance(0);
  await bridge("close");
  // The server still says 0 shown; the local count stops a second showing.
  expect(await inApp.show({ name: "promo" })).toBe(false);

  eventsStatus = [500];
  await advance(2_000);
  const first = calls.filter((c) => c.url.endsWith("/in-app/events/"));
  expect(first).toHaveLength(1);
  expect(first[0].body.events.map((e: { type: string }) => e.type)).toEqual(["shown", "dismissed"]);
  await advance(10_000);
  const all = calls.filter((c) => c.url.endsWith("/in-app/events/"));
  expect(all).toHaveLength(2);
  expect(all[1].body).toEqual(first[0].body);
});

test("app_open shows once per foreground, again only after the page was hidden", async () => {
  const { inApp } = await load();
  answer = { messages: [message({ cap_per_device: null })], allowed_origins: [] };
  await inApp.refresh();

  inApp.foreground();
  await advance(0);
  expect(frame()).not.toBeNull();
  await bridge("close");

  inApp.foreground();
  await advance(0);
  expect(frame()).toBeNull();

  inApp.background();
  inApp.foreground();
  await advance(0);
  expect(frame()).not.toBeNull();
});

test("a coach mark shows only while its marked element is on screen, with its frame as the target", async () => {
  const { inApp } = await load();
  answer = { messages: [message({ format: "coach_mark", trigger: "show_in_app", trigger_name: "tip", coach_target: "compose" })], allowed_origins: [] };
  await inApp.refresh();
  inApp.markView("#compose", "compose");

  expect(await inApp.show({ name: "tip" })).toBe(false);
  document.body.insertAdjacentHTML("beforeend", `<button id="compose"></button>`);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const size = this.id === "compose" ? [16, 700, 56, 56] : [0, 0, 0, 0];
    const [x, y, width, height] = size;
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
  });
  expect(await inApp.show({ name: "tip" })).toBe(true);
  expect(frame()!.getAttribute("srcdoc")).toContain('"target":{"x":16,"y":700,"width":56,"height":56}');
});

test("the public showInApp is false before init, and forget clears the in-app cache", async () => {
  const sdk = await import("../src/index");
  expect(await sdk.showInApp("checkout")).toBe(false);
  const { inApp, storage } = await load();
  answer = { messages: [message()], allowed_origins: [] };
  await inApp.refresh();
  expect(await storage.keys("pages")).toHaveLength(1);
  await inApp.reset();
  expect(await storage.keys("pages")).toEqual([]);
  expect(await storage.get("kv", "answer")).toBeUndefined();
});
