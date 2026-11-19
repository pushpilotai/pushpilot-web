// The on-screen part of in-app messages (IN-APP-SDK.md sections 4 to 6 and 9): a full-viewport
// sandboxed iframe, the bridge's page-to-SDK messages, links, vibration, safe-area insets,
// coach-mark targets and the viewport posture.
import type { Rect } from "./message";
import type { BridgeValues, Posture } from "./page";

/** What the host does when the page reports something. */
export interface FrameCallbacks {
  /** The page is on screen. */
  onShown(): void;
  /** The page called track with a valid button id. */
  onTrack(buttonId: string): void;
  /** The message closed; `tracked` tells whether track was called during this showing. */
  onClose(tracked: boolean): void;
}

/** Vibration patterns for pushpilot.haptic, in ms. */
const HAPTICS: Record<string, number | number[]> = {
  light: 10,
  medium: 20,
  heavy: 30,
  selection: 5,
  success: [10, 60, 10],
  warning: [20, 60, 20],
  error: [30, 60, 30, 60, 30],
};

/** Schemes pushpilot.open refuses. */
const REFUSED = /^(javascript|data|file|blob|vbscript):$/i;

/** One page-to-SDK call, from `{pushpilot: "<json>"}`; null for anything else. */
export function parseCall(data: unknown): { type: string; value: string } | null {
  const raw = (data as { pushpilot?: unknown } | null)?.pushpilot;
  if (typeof raw !== "string") return null;
  try {
    const call = JSON.parse(raw) as { type?: unknown; value?: unknown };
    if (typeof call.type !== "string") return null;
    return { type: call.type, value: typeof call.value === "string" ? call.value : "" };
  } catch {
    return null;
  }
}

/** The absolute URL to open, or null for a refused scheme or an unreadable URL. */
export function safeUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    return REFUSED.test(url.protocol) ? null : url.href;
  } catch {
    return null;
  }
}

/** A button id the events route accepts: 1 to 64 bytes of UTF-8 (the server counts bytes). */
export function isButtonId(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).length <= 64;
}

/** The web's posture: always flat, with the viewport size. */
export function posture(): Posture {
  return { state: "flat", screen: { width: window.innerWidth, height: window.innerHeight } };
}

/** Safe-area insets from env(safe-area-inset-*) via a hidden probe; 0 where the browser has none. */
export function insets(): BridgeValues["insets"] {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (value: string) => parseFloat(value) || 0;
  const result = { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
  probe.remove();
  return result;
}

/** The frame of the first visible, on-screen match for `selector`, or null. */
export function findTarget(selector: string): Rect | null {
  let nodes: NodeListOf<Element>;
  try {
    nodes = document.querySelectorAll(selector);
  } catch {
    return null; // not a valid selector
  }
  for (const node of nodes) {
    const r = node.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    if (onScreen && getComputedStyle(node).visibility !== "hidden") return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return null;
}

/** Opens a link from the page in the top window. */
function navigate(url: string): void {
  window.location.assign(url);
}

/**
 * Puts `html` on screen in a transparent full-viewport iframe that may run scripts and nothing
 * else (no same origin, navigation, popups or forms), and handles its bridge calls. Messages are
 * accepted only from this iframe's own window.
 */
export function showFrame(html: string, callbacks: FrameCallbacks): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "Message");
  frame.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;border:0;margin:0;padding:0;background:transparent;color-scheme:normal;z-index:2147483647";
  frame.srcdoc = html;
  let tracked = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("message", onMessage);
    window.removeEventListener("resize", onResize);
    frame.remove();
    callbacks.onClose(tracked);
  };
  const onMessage = (event: MessageEvent) => {
    if (frame.contentWindow === null || event.source !== frame.contentWindow) return;
    const call = parseCall(event.data);
    if (!call) return;
    if (call.type === "close") close();
    else if (call.type === "open") {
      const url = safeUrl(call.value, window.location.href);
      if (!url) return; // refused: the message stays open
      close();
      navigate(url);
    } else if (call.type === "haptic") {
      const pattern = HAPTICS[call.value];
      if (pattern !== undefined && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
    } else if (call.type === "track" && isButtonId(call.value)) {
      tracked = true;
      callbacks.onTrack(call.value);
    }
  };
  // The frame is sandboxed, so posture goes in as a message its bridge listens for.
  const onResize = () => frame.contentWindow?.postMessage({ pushpilotPosture: posture() }, "*");

  frame.addEventListener("load", () => !closed && callbacks.onShown(), { once: true });
  window.addEventListener("message", onMessage);
  window.addEventListener("resize", onResize);
  document.body.appendChild(frame);
  frame.focus();
  return frame;
}
