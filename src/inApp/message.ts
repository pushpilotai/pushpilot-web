// In-app messages as the fetch returns them (IN-APP-SDK.md section 1), and the rules for
// when a cached one may show (section 3). Pure functions only, so they test without a browser.

/** One message from `GET /api/sdk/v1/in-app/`. */
export interface InAppMessage {
  id: string;
  name: string;
  format: string;
  trigger: "app_open" | "show_in_app";
  trigger_name: string | null;
  html_url: string;
  light_html_url: string | null;
  html_version: number;
  assets: string[];
  cap_per_device: number | null;
  shown_count: number;
  coach_target: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

/** The fetch answer, checked. */
export interface FetchAnswer {
  messages: InAppMessage[];
  allowed_origins: string[];
}

/** A rectangle in CSS px, as the bridge hands it to the page. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What eligibility needs besides the message itself. */
export interface Conditions {
  now: number;
  /** This device's own shown count per message id. */
  counts: Record<string, number>;
  /** Cache keys of the pages that are fully cached. */
  cached: Set<string>;
  /** Looks up a marked view's frame on screen; null when it is not there. */
  target: (name: string) => Rect | null;
}

/** Only http(s) URLs are downloaded. */
function isWebUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** A string, or null for anything else. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Checks one message; null when it lacks what showing needs. */
function parseMessage(raw: unknown): InAppMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id) return null;
  if (m.trigger !== "app_open" && m.trigger !== "show_in_app") return null;
  if (!isWebUrl(m.html_url) || !Number.isInteger(m.html_version)) return null;
  if (!Array.isArray(m.assets) || !m.assets.every(isWebUrl)) return null;
  const cap = m.cap_per_device;
  return {
    id: m.id,
    name: text(m.name) ?? "",
    format: text(m.format) ?? "",
    trigger: m.trigger,
    trigger_name: text(m.trigger_name),
    html_url: m.html_url,
    light_html_url: isWebUrl(m.light_html_url) ? m.light_html_url : null,
    html_version: m.html_version as number,
    assets: m.assets,
    cap_per_device: typeof cap === "number" && Number.isFinite(cap) ? cap : null,
    shown_count: typeof m.shown_count === "number" && Number.isFinite(m.shown_count) ? m.shown_count : 0,
    coach_target: text(m.coach_target),
    starts_at: text(m.starts_at),
    ends_at: text(m.ends_at),
  };
}

/** True for a bare https origin, so nothing else can reach the policy text. */
function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/** Reads the fetch body; malformed messages and origins are dropped, a malformed body gives null. */
export function parseAnswer(body: string): FetchAnswer | null {
  let json: { messages?: unknown; allowed_origins?: unknown };
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || !Array.isArray(json.messages)) return null;
  const messages = json.messages.map(parseMessage).filter((m): m is InAppMessage => m !== null);
  const origins = Array.isArray(json.allowed_origins) ? json.allowed_origins.filter(isOrigin) : [];
  return { messages, allowed_origins: origins };
}

/** The cache key: message id and HTML version, so a new version is a new entry. */
export function cacheKey(message: Pick<InAppMessage, "id" | "html_version">): string {
  return `${message.id}:${message.html_version}`;
}

/** A slow device by I9: the browser reports under 3 GB of memory. Unreported means not slow. */
export function isSlowDevice(nav: { deviceMemory?: number } | undefined): boolean {
  const memory = nav?.deviceMemory;
  return typeof memory === "number" && memory < 3;
}

/** The page to download: the light one on a slow device when there is one. */
export function pageUrl(message: InAppMessage, slow: boolean): { url: string; light: boolean } {
  return slow && message.light_html_url ? { url: message.light_html_url, light: true } : { url: message.html_url, light: false };
}

/**
 * True when the message may show now: cached, under its cap (the larger of the local and server
 * counts), inside its dates by the device clock, and for a coach mark, its target on screen.
 * An unreadable date counts as not met.
 */
export function eligible(message: InAppMessage, c: Conditions): boolean {
  if (!c.cached.has(cacheKey(message))) return false;
  const shown = Math.max(c.counts[message.id] ?? 0, message.shown_count);
  if (message.cap_per_device !== null && shown >= message.cap_per_device) return false;
  if (message.starts_at !== null && !(Date.parse(message.starts_at) <= c.now)) return false;
  if (message.ends_at !== null && !(c.now < Date.parse(message.ends_at))) return false;
  if (message.format === "coach_mark") return message.coach_target !== null && c.target(message.coach_target) !== null;
  return true;
}

/** The first message for this trigger that may show, in the fetch's order, or null. */
export function pick(messages: InAppMessage[], trigger: { appOpen: true } | { name: string }, c: Conditions): InAppMessage | null {
  const wanted = (m: InAppMessage) => ("appOpen" in trigger ? m.trigger === "app_open" : m.trigger === "show_in_app" && m.trigger_name === trigger.name);
  return messages.find((m) => wanted(m) && eligible(m, c)) ?? null;
}
