// Shared in-app test data.
import type { InAppMessage } from "../src/inApp/message";

/** A message as the server sends it, with `fields` overriding. */
export function message(fields: Partial<InAppMessage> = {}): InAppMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Welcome",
    format: "modal",
    trigger: "app_open",
    trigger_name: null,
    html_url: "https://cdn.test/v3.html",
    light_html_url: "https://cdn.test/v3.light.html",
    html_version: 3,
    assets: ["https://cdn.test/hero.png"],
    cap_per_device: 2,
    shown_count: 0,
    coach_target: null,
    starts_at: null,
    ends_at: null,
    ...fields,
  };
}
