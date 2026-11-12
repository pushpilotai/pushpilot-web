// Fakes for the browser APIs the SDK touches: fetch (a scripted PushPilot server), PushManager,
// Notification, the service worker registration and clients, and IndexedDB (fake-indexeddb).
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { vi } from "vitest";

/** Encodes bytes as unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A P-256 public key shape (65 bytes, leading 0x04) filled with `fill`. */
export function keyBytes(fill: number): Uint8Array {
  const bytes = new Uint8Array(65).fill(fill);
  bytes[0] = 4;
  return bytes;
}

export const OUR_KEY = base64url(keyBytes(1));
export const ONESIGNAL_KEY = keyBytes(2);
export const SDK_KEY = "pk_test_web";
export const BASE_URL = "https://push.test";
export const SCOPE = "https://shop.test/";

/** One request the fake server received. */
export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

/** A scripted answer; `body` is sent as JSON. */
export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A browser push subscription bound to the key it was made with. */
export class FakeSubscription {
  unsubscribed = false;
  readonly options: { applicationServerKey: ArrayBuffer | null; userVisibleOnly: boolean };
  constructor(
    readonly endpoint: string,
    key: Uint8Array | null,
    private readonly manager: FakePushManager,
  ) {
    this.options = { applicationServerKey: key ? (key.slice().buffer as ArrayBuffer) : null, userVisibleOnly: true };
  }
  /** Drops this subscription from its manager. */
  async unsubscribe() {
    this.unsubscribed = true;
    if (this.manager.current === this) this.manager.current = null;
    return true;
  }
  /** The serialised form browsers give, with base64url keys. */
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: `p256dh-${this.endpoint.slice(-1)}`, auth: `auth-${this.endpoint.slice(-1)}` } };
  }
}

/** PushManager: one current subscription; subscribing needs granted permission. */
export class FakePushManager {
  current: FakeSubscription | null = null;
  subscribeCalls: { userVisibleOnly?: boolean; applicationServerKey: Uint8Array }[] = [];
  constructor(private readonly env: Env) {}
  async getSubscription() {
    return this.current;
  }
  async subscribe(options: { userVisibleOnly?: boolean; applicationServerKey: Uint8Array }) {
    this.subscribeCalls.push(options);
    if (this.env.Notification.permission !== "granted") throw new DOMException("permission denied", "NotAllowedError");
    this.current = new FakeSubscription(`https://fcm.googleapis.com/fcm/send/sub${this.subscribeCalls.length}`, new Uint8Array(options.applicationServerKey), this);
    return this.current;
  }
}

/** Everything one test needs, installed as globals by {@link setup}. */
export interface Env {
  calls: Call[];
  replies: Partial<Record<string, Reply[]>>;
  pushManager: FakePushManager;
  registration: any;
  shown: { title: string; options: any }[];
  opened: string[];
  focused: string[];
  windows: { url: string; focus: () => Promise<void> }[];
  Notification: { permission: NotificationPermission; maxActions?: number; requestPermission: ReturnType<typeof vi.fn> };
  listeners: Record<string, (event: any) => void>;
  fetchFails: boolean;
}

/**
 * Installs fresh fakes as globals and returns them. `permission` is the browser's current state
 * and `answer` what the prompt would return. Modules must be imported after this (vi.resetModules).
 */
export function setup({ permission = "default" as NotificationPermission, answer = "granted" as NotificationPermission } = {}): Env {
  vi.resetModules();
  const env = {
    calls: [],
    replies: {},
    shown: [],
    opened: [],
    focused: [],
    windows: [],
    listeners: {},
    fetchFails: false,
  } as unknown as Env;
  env.Notification = {
    permission,
    maxActions: 2,
    requestPermission: vi.fn(async () => {
      env.Notification.permission = answer;
      return answer;
    }),
  };
  env.pushManager = new FakePushManager(env);
  env.registration = {
    active: {},
    scope: SCOPE,
    pushManager: env.pushManager,
    showNotification: vi.fn(async (title: string, options: unknown) => void env.shown.push({ title, options })),
  };
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("Notification", env.Notification);
  vi.stubGlobal("PushManager", FakePushManager);
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    language: "en-GB",
    serviceWorker: {
      register: vi.fn(async () => env.registration),
      getRegistration: vi.fn(async () => env.registration),
    },
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (type: string, listener: (event: any) => void) => (env.listeners[`document:${type}`] = listener),
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => serve(env, url, init)));
  // The service worker's global scope, for tests that import src/sw.ts.
  vi.stubGlobal("self", {
    registration: env.registration,
    location: new URL(`${SCOPE}pushpilot-sw.js`),
    addEventListener: (type: string, listener: (event: any) => void) => (env.listeners[type] = listener),
    skipWaiting: vi.fn(),
    clients: {
      matchAll: vi.fn(async () => env.windows),
      openWindow: vi.fn(async (url: string) => void env.opened.push(url)),
    },
  });
  return env;
}

/** The fake PushPilot server: records each call and answers from `env.replies` or a default. */
async function serve(env: Env, url: string, init: RequestInit): Promise<Response> {
  if (env.fetchFails) throw new TypeError("Failed to fetch");
  const path = url.replace(BASE_URL, "");
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  env.calls.push({ method: init.method ?? "GET", path, headers: { ...(init.headers as Record<string, string>) }, body });
  const scripted = env.replies[path]?.shift();
  const reply = scripted ?? defaultReply(path, body);
  return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
}

/** What the real server answers when the test scripted nothing. */
function defaultReply(path: string, body: any): Reply {
  if (path === "/api/sdk/v1/web-config/") return { status: 200, body: { vapid_public_key: OUR_KEY } };
  if (path === "/api/sdk/v1/forget/") return { status: 204 };
  if (path === "/api/sdk/v1/events/") return { status: 200, body: { received: body.events.length } };
  return { status: 200, body: { installation_id: body.installation_id, throttled: false, warnings: [] } };
}

/** Lets pending IndexedDB work and promise chains run. */
export async function idle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Advances fake time by `ms` in steps, letting storage work run in between. */
export async function advance(ms: number): Promise<void> {
  await idle();
  const step = Math.max(1, Math.ceil(ms / 10));
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
    await idle();
  }
}

/** Calls to one SDK path. */
export function callsTo(env: Env, path: string): Call[] {
  return env.calls.filter((c) => c.path === `/api/sdk/v1/${path}/`);
}

/** A notification event as the browser dispatches it, collecting waitUntil promises. */
export function swEvent(fields: Record<string, unknown>) {
  const pending: Promise<unknown>[] = [];
  return { ...fields, pending, waitUntil: (p: Promise<unknown>) => void pending.push(p), done: () => Promise.all(pending) };
}

/** Push message data whose json() parses `text`, as PushMessageData does. */
export function pushData(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { json: () => JSON.parse(text), text: () => text };
}
