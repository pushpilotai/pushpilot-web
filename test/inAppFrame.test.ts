// @vitest-environment jsdom
// In-app messages in a DOM: the iframe's lockdown attributes, accepting bridge calls only from
// its own window, links, vibration, track versus dismissed, coach-mark targets, posture, and the
// bridge script itself.
import { afterEach, expect, test, vi } from "vitest";
import { findTarget, insets, isButtonId, safeUrl, showFrame, type FrameCallbacks } from "../src/inApp/frame";
import { bridgeScript } from "../src/inApp/page";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Callbacks that record what the frame reported. */
function recorder() {
  const seen = { shown: 0, tracks: [] as string[], closed: [] as boolean[] };
  const callbacks: FrameCallbacks = {
    onShown: () => void seen.shown++,
    onTrack: (id) => void seen.tracks.push(id),
    onClose: (tracked) => void seen.closed.push(tracked),
  };
  return { seen, callbacks };
}

/** Sends a bridge call as the page would, from `source`. */
function call(source: Window | null, type: string, value?: string) {
  window.dispatchEvent(new MessageEvent("message", { data: { pushpilot: JSON.stringify({ type, value }) }, source }));
}

test("the iframe is full-viewport, transparent, on top, and sandboxed to scripts only", () => {
  const frame = showFrame("<p>hi</p>", recorder().callbacks);
  expect(document.body.lastElementChild).toBe(frame);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("srcdoc")).toBe("<p>hi</p>");
  expect(frame.getAttribute("allow")).toBe("camera 'none'; microphone 'none'; geolocation 'none'");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.getAttribute("src")).toBeNull();
  expect(frame.style.position).toBe("fixed");
  expect(frame.style.width).toBe("100%");
  expect(frame.style.height).toBe("100%");
  expect(frame.style.background).toBe("transparent");
  expect(frame.style.zIndex).toBe("2147483647");
  expect(frame.style.borderStyle || frame.style.border).toMatch(/^(0|none|0px.*)$/);
});

test("bridge calls are accepted only from the message's own iframe window", () => {
  const { seen, callbacks } = recorder();
  const frame = showFrame("<p>hi</p>", callbacks);
  call(window, "close");
  call(null, "close");
  // A sibling iframe on the host page.
  const other = document.createElement("iframe");
  document.body.appendChild(other);
  call(other.contentWindow, "close");
  expect(frame.isConnected).toBe(true);
  // Not the bridge's shape.
  window.dispatchEvent(new MessageEvent("message", { data: { type: "close" }, source: frame.contentWindow }));
  window.dispatchEvent(new MessageEvent("message", { data: { pushpilot: "{not json" }, source: frame.contentWindow }));
  expect(frame.isConnected).toBe(true);

  call(frame.contentWindow, "close");
  expect(frame.isConnected).toBe(false);
  expect(seen.closed).toEqual([false]);
  // Closed once only.
  call(frame.contentWindow, "close");
  expect(seen.closed).toEqual([false]);
});

test("shown is reported when the page loads; track records clicks and a tracked showing closes without dismissed", () => {
  const { seen, callbacks } = recorder();
  const frame = showFrame("<p>hi</p>", callbacks);
  frame.dispatchEvent(new Event("load"));
  frame.dispatchEvent(new Event("load"));
  expect(seen.shown).toBe(1);
  call(frame.contentWindow, "track", "buy");
  call(frame.contentWindow, "track", "later");
  call(frame.contentWindow, "close");
  expect(seen.tracks).toEqual(["buy", "later"]);
  expect(seen.closed).toEqual([true]);
});

test("track with an id the server would reject is ignored, so the showing still counts as dismissed", () => {
  const { seen, callbacks } = recorder();
  const frame = showFrame("<p>hi</p>", callbacks);
  call(frame.contentWindow, "track", "x".repeat(65));
  call(frame.contentWindow, "track", "é".repeat(33)); // 66 bytes
  call(frame.contentWindow, "track", "");
  call(frame.contentWindow, "close");
  expect(seen.tracks).toEqual([]);
  expect(seen.closed).toEqual([false]);
  expect(isButtonId("x".repeat(64))).toBe(true);
  expect(isButtonId("é".repeat(32))).toBe(true);
});

test("open refuses script, data, file and blob URLs and keeps the message; others close it and navigate the top window", () => {
  const { seen, callbacks } = recorder();
  const frame = showFrame("<p>hi</p>", callbacks);
  for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "file:///etc/passwd", "blob:https://x.test/1", "vbscript:x", "http://["]) {
    call(frame.contentWindow, "open", url);
  }
  expect(frame.isConnected).toBe(true);
  expect(seen.closed).toEqual([]);

  // jsdom navigates only within the document, so a fragment shows location.assign ran.
  call(frame.contentWindow, "open", "#offer");
  expect(frame.isConnected).toBe(false);
  expect(seen.closed).toEqual([false]);
  expect(window.location.hash).toBe("#offer");

  expect(safeUrl("/checkout", "https://shop.test/cart")).toBe("https://shop.test/checkout");
  expect(safeUrl("myapp://offer/1", "https://shop.test/")).toBe("myapp://offer/1");
});

test("haptic vibrates for known kinds where the browser can, and does nothing otherwise", () => {
  const frame = showFrame("<p>hi</p>", recorder().callbacks);
  call(frame.contentWindow, "haptic", "light"); // no navigator.vibrate in jsdom: nothing happens
  const vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
  call(frame.contentWindow, "haptic", "success");
  call(frame.contentWindow, "haptic", "explode");
  expect(vibrate.mock.calls).toEqual([[[10, 60, 10]]]);
  delete (navigator as { vibrate?: unknown }).vibrate;
});

test("a resize sends the flat posture with the viewport size into the frame", () => {
  const frame = showFrame("<p>hi</p>", recorder().callbacks);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  window.dispatchEvent(new Event("resize"));
  expect(post).toHaveBeenCalledWith({ pushpilotPosture: { state: "flat", screen: { width: window.innerWidth, height: window.innerHeight } } }, "*");
  // After close nothing more is sent.
  call(frame.contentWindow, "close");
  post.mockClear();
  window.dispatchEvent(new Event("resize"));
  expect(post).not.toHaveBeenCalled();
});

test("insets are 0 where the browser has no safe area", () => {
  expect(insets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  expect(document.body.children).toHaveLength(0);
});

test("a coach-mark target is the first visible on-screen match; none when absent, hidden, off screen or not a selector", () => {
  document.body.innerHTML = `<button class="c" id="zero"></button><button class="c" id="off"></button><button class="c" id="hidden" style="visibility:hidden"></button><button class="c" id="real"></button>`;
  const rects: Record<string, [number, number, number, number]> = {
    zero: [10, 10, 0, 0],
    off: [10, window.innerHeight + 5, 40, 40],
    hidden: [10, 10, 40, 40],
    real: [12, 600, 48, 32],
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const [x, y, width, height] = rects[this.id] ?? [0, 0, 0, 0];
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
  });
  expect(findTarget(".c")).toEqual({ x: 12, y: 600, width: 48, height: 32 });
  expect(findTarget("#zero")).toBeNull();
  expect(findTarget("#off")).toBeNull();
  expect(findTarget("#hidden")).toBeNull();
  expect(findTarget("#missing")).toBeNull();
  expect(findTarget("[[nope")).toBeNull();
});

test("the bridge script defines window.pushpilot, sends calls to its parent, and takes posture only from its parent", () => {
  const start = { state: "flat" as const, screen: { width: 390, height: 844 } };
  const script = bridgeScript({ insets: { top: 1, right: 2, bottom: 3, left: 4 }, target: null, light: true, posture: start });
  // Run it in this window; here `parent` is the window itself.
  new Function(script.replace(/^<script>/, "").replace(/<\/script>$/, ""))();
  const bridge = (window as unknown as { pushpilot: Record<string, any> }).pushpilot;
  expect(bridge).toMatchObject({ insets: { top: 1, right: 2, bottom: 3, left: 4 }, island: null, target: null, platform: "web", light: true, posture: start });

  const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  bridge.track("buy");
  bridge.open("https://shop.test/");
  bridge.haptic("light");
  bridge.close();
  expect(post.mock.calls).toEqual([
    [{ pushpilot: '{"type":"track","value":"buy"}' }, "*"],
    [{ pushpilot: '{"type":"open","value":"https://shop.test/"}' }, "*"],
    [{ pushpilot: '{"type":"haptic","value":"light"}' }, "*"],
    [{ pushpilot: '{"type":"close","value":""}' }, "*"],
  ]);

  const seen: unknown[] = [];
  const events: unknown[] = [];
  bridge.onPosture((p: unknown) => seen.push(p));
  window.addEventListener("pushpilotposture", (e) => events.push((e as CustomEvent).detail));
  expect(seen).toEqual([start]);
  const next = { state: "flat", screen: { width: 844, height: 390 } };
  window.dispatchEvent(new MessageEvent("message", { data: { pushpilotPosture: next }, source: null }));
  expect(seen).toHaveLength(1);
  window.dispatchEvent(new MessageEvent("message", { data: { pushpilotPosture: next }, source: window }));
  expect(seen).toEqual([start, next]);
  expect(events).toEqual([next]);
  expect(bridge.posture).toEqual(next);
});
