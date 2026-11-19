// In-app messages, the parts without a DOM: the fetch answer, cache keys, slow devices, which
// message may show, assets as data URIs, and the policy and bridge inserted after <head>.
import { expect, test } from "vitest";
import { cacheKey, eligible, isSlowDevice, pageUrl, parseAnswer, pick, type Conditions, type InAppMessage } from "../src/inApp/message";
import { message } from "./inAppFakes";
import { bridgeScript, cspMeta, dataUri, framePage, inlineAssets, insertAfterHead, type BridgeValues } from "../src/inApp/page";

const NOW = Date.parse("2026-11-19T12:00:00Z");

/** Conditions where everything given is cached and nothing has been shown. */
function conditions(messages: InAppMessage[], fields: Partial<Conditions> = {}): Conditions {
  return { now: NOW, counts: {}, cached: new Set(messages.map(cacheKey)), target: () => null, ...fields };
}

const VALUES: BridgeValues = {
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
  target: null,
  light: false,
  posture: { state: "flat", screen: { width: 390, height: 844 } },
};

test("the fetch answer is read as the contract gives it; malformed messages and origins are dropped", () => {
  const good = message();
  const body = JSON.stringify({
    messages: [good, { ...good, id: "" }, { ...good, trigger: "event" }, { ...good, html_url: "javascript:alert(1)" }, { ...good, assets: [1] }, "junk"],
    allowed_origins: ["https://api.example.com", "https://api.example.com/path", "http://plain.example.com", "https://x.test; script-src *", 7],
  });
  expect(parseAnswer(body)).toEqual({ messages: [good], allowed_origins: ["https://api.example.com"] });
  expect(parseAnswer("not json")).toBeNull();
  expect(parseAnswer(JSON.stringify({ allowed_origins: [] }))).toBeNull();
  // Optional fields of the wrong type fall back rather than reject the message.
  const loose = parseAnswer(JSON.stringify({ messages: [{ ...good, light_html_url: 5, cap_per_device: "2", shown_count: null }] }))!;
  expect(loose.messages[0]).toMatchObject({ light_html_url: null, cap_per_device: null, shown_count: 0 });
  expect(loose.allowed_origins).toEqual([]);
});

test("the cache key is the message id and HTML version", () => {
  expect(cacheKey(message())).toBe("11111111-1111-4111-8111-111111111111:3");
  expect(cacheKey(message({ html_version: 4 }))).not.toBe(cacheKey(message()));
});

test("a slow device reports under 3 GB and gets the light page when there is one", () => {
  expect(isSlowDevice({ deviceMemory: 2 })).toBe(true);
  expect(isSlowDevice({ deviceMemory: 4 })).toBe(false);
  expect(isSlowDevice({})).toBe(false);
  expect(isSlowDevice(undefined)).toBe(false);
  expect(pageUrl(message(), true)).toEqual({ url: "https://cdn.test/v3.light.html", light: true });
  expect(pageUrl(message(), false)).toEqual({ url: "https://cdn.test/v3.html", light: false });
  expect(pageUrl(message({ light_html_url: null }), true)).toEqual({ url: "https://cdn.test/v3.html", light: false });
});

test("only a fully cached message may show", () => {
  const m = message();
  expect(eligible(m, conditions([m]))).toBe(true);
  expect(eligible(m, conditions([m], { cached: new Set() }))).toBe(false);
  expect(eligible(m, conditions([m], { cached: new Set([cacheKey(message({ html_version: 2 }))]) }))).toBe(false);
});

test("the cap uses the larger of the local and server shown counts", () => {
  const m = message({ cap_per_device: 2, shown_count: 1 });
  expect(eligible(m, conditions([m]))).toBe(true);
  expect(eligible(m, conditions([m], { counts: { [m.id]: 2 } }))).toBe(false);
  expect(eligible(message({ cap_per_device: 2, shown_count: 2 }), conditions([m], { counts: { [m.id]: 0 } }))).toBe(false);
  expect(eligible(message({ cap_per_device: null, shown_count: 50 }), conditions([m], { counts: { [m.id]: 50 } }))).toBe(true);
});

test("dates are checked against the device clock; an unreadable date is not met", () => {
  const at = (starts_at: string | null, ends_at: string | null) => {
    const m = message({ starts_at, ends_at });
    return eligible(m, conditions([m]));
  };
  expect(at("2026-11-19T11:00:00Z", "2026-11-19T13:00:00Z")).toBe(true);
  expect(at("2026-11-19T12:00:00Z", null)).toBe(true);
  expect(at("2026-11-19T12:00:01Z", null)).toBe(false);
  expect(at(null, "2026-11-19T12:00:00Z")).toBe(false);
  expect(at("soon", null)).toBe(false);
  expect(at(null, "later")).toBe(false);
});

test("triggers: app_open takes the first eligible app_open message; showInApp matches the trigger name", () => {
  const capped = message({ id: "a", shown_count: 2 });
  const open = message({ id: "b" });
  const checkout = message({ id: "c", trigger: "show_in_app", trigger_name: "checkout" });
  const list = [checkout, capped, open];
  const c = conditions(list);
  expect(pick(list, { appOpen: true }, c)?.id).toBe("b");
  expect(pick(list, { name: "checkout" }, c)?.id).toBe("c");
  expect(pick(list, { name: "cart" }, c)).toBeNull();
  // An app_open message is never shown by name, even one whose trigger_name matches.
  expect(pick([message({ trigger_name: "checkout" })], { name: "checkout" }, c)).toBeNull();
});

test("a coach mark shows only when its target is on screen", () => {
  const coach = message({ format: "coach_mark", coach_target: "compose" });
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  expect(eligible(coach, conditions([coach], { target: (name) => (name === "compose" ? rect : null) }))).toBe(true);
  expect(eligible(coach, conditions([coach]))).toBe(false);
  expect(eligible(message({ format: "coach_mark", coach_target: null }), conditions([coach], { target: () => rect }))).toBe(false);
  // Other formats ignore coach_target.
  expect(eligible(message({ coach_target: "compose" }), conditions([coach]))).toBe(true);
});

test("assets become data URIs everywhere they appear; a URL that prefixes another does not cut it", () => {
  expect(dataUri(new Uint8Array([104, 105]), "image/png")).toBe("data:image/png;base64,aGk=");
  expect(dataUri(new Uint8Array([104, 105]), "text/css; charset=utf-8")).toBe("data:text/css;base64,aGk=");
  expect(dataUri(new Uint8Array([104, 105]), 'image/png" onload="x')).toBe("data:application/octet-stream;base64,aGk=");
  expect(dataUri(new Uint8Array([104, 105]), null)).toBe("data:application/octet-stream;base64,aGk=");
  // Large files are encoded in chunks.
  expect(dataUri(new Uint8Array(100_000).fill(65), "font/woff2")).toBe(`data:font/woff2;base64,${btoa("A".repeat(100_000))}`);

  const html = `<img src="https://cdn.test/a.png"><img src="https://cdn.test/a.png?v=2"><style>.x{background:url(https://cdn.test/a.png)}</style>`;
  expect(inlineAssets(html, { "https://cdn.test/a.png": "data:A", "https://cdn.test/a.png?v=2": "data:B" })).toBe(
    `<img src="data:A"><img src="data:B"><style>.x{background:url(data:A)}</style>`,
  );
});

test("the content security policy lists the allowed origins, or none", () => {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
  expect(cspMeta([])).toBe(`<meta http-equiv="Content-Security-Policy" content="${policy}; connect-src 'none'">`);
  expect(cspMeta(["https://a.test", "https://b.test"])).toBe(`<meta http-equiv="Content-Security-Policy" content="${policy}; connect-src https://a.test https://b.test">`);
});

test("the policy and bridge go right after <head>, or at the very start without one", () => {
  expect(insertAfterHead("<!doctype html><html><head><title>x</title></head></html>", "[X]")).toBe("<!doctype html><html><head>[X]<title>x</title></head></html>");
  expect(insertAfterHead(`<HTML><HEAD lang="en"><script>first()</script>`, "[X]")).toBe(`<HTML><HEAD lang="en">[X]<script>first()</script>`);
  expect(insertAfterHead("<header>hi</header>", "[X]")).toBe("[X]<header>hi</header>");
  expect(insertAfterHead("<p>bare</p>", "[X]")).toBe("[X]<p>bare</p>");

  const page = framePage("<html><head><script>page()</script></head></html>", [], VALUES);
  expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("window.pushpilot="));
  expect(page.indexOf("window.pushpilot=")).toBeLessThan(page.indexOf("page()"));
});

test("the bridge carries the values and cannot be closed early by them", () => {
  const script = bridgeScript({ ...VALUES, target: { x: 1, y: 2, width: 3, height: 4 } });
  expect(script).toContain('"insets":{"top":47,"right":0,"bottom":34,"left":0}');
  expect(script).toContain('"target":{"x":1,"y":2,"width":3,"height":4}');
  expect(script).toContain('platform:"web"');
  expect(script).toContain("island:null");
  const hostile = bridgeScript({ ...VALUES, posture: { state: "</script><script>bad()" as "flat", screen: { width: 1, height: 1 } } });
  expect(hostile.match(/<\/script>/g)).toHaveLength(1);
});
