// Turns a downloaded message page into the string the iframe loads: assets inlined as data URIs
// (IN-APP-SDK.md section 2), then the content security policy and the bridge script inserted
// right after <head> (sections 4, 5 and 9). Pure string work, no DOM.
import type { Rect } from "./message";

/** The device posture the bridge hands the page; always "flat" on the web. */
export interface Posture {
  state: "flat";
  screen: { width: number; height: number };
}

/** Values the bridge script fills in for the page. */
export interface BridgeValues {
  insets: { top: number; right: number; bottom: number; left: number };
  target: Rect | null;
  light: boolean;
  posture: Posture;
}

/** A MIME type safe to put in a data URI; anything odd becomes application/octet-stream. */
function mimeOf(contentType: string | null): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream";
}

/** Encodes bytes as a base64 data URI. */
export function dataUri(bytes: Uint8Array, contentType: string | null): string {
  let binary = "";
  // Chunked so a large image does not overflow the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mimeOf(contentType)};base64,${btoa(binary)}`;
}

/** Replaces every occurrence of each asset URL with its data URI; longer URLs first, so a prefix cannot cut one. */
export function inlineAssets(html: string, assets: Record<string, string>): string {
  return Object.keys(assets)
    .sort((a, b) => b.length - a.length)
    .reduce((page, url) => page.split(url).join(assets[url]), html);
}

/** The content security policy meta tag; origins must already be checked bare https origins. */
export function cspMeta(allowedOrigins: string[]): string {
  const connect = allowedOrigins.length ? allowedOrigins.join(" ") : "'none'";
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; ` +
    `style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src ${connect}">`
  );
}

/**
 * The bridge script defining `window.pushpilot` before any page script runs. Page calls go to the
 * SDK as `parent.postMessage({pushpilot: json}, "*")`; posture changes come back from the parent
 * window as `{pushpilotPosture: posture}` and go through `pushpilot._posture`.
 */
export function bridgeScript(values: BridgeValues): string {
  // "<" escaped so no value can close the script element.
  const config = JSON.stringify(values).replace(/</g, "\\u003c");
  return `<script>(function(){var c=${config},fns=[];
function send(t,v){parent.postMessage({pushpilot:JSON.stringify({type:t,value:v==null?"":String(v)})},"*");}
var p={close:function(){send("close");},open:function(u){send("open",u);},haptic:function(k){send("haptic",k);},
track:function(b){send("track",b);},insets:c.insets,island:null,target:c.target,platform:"web",light:c.light,posture:c.posture,
onPosture:function(fn){if(typeof fn!=="function")return;fns.push(fn);fn(p.posture);},
_posture:function(next){p.posture=next;fns.forEach(function(fn){try{fn(next);}catch(e){console.error(e);}});
window.dispatchEvent(new CustomEvent("pushpilotposture",{detail:next}));}};
window.pushpilot=p;
window.addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.pushpilotPosture)p._posture(e.data.pushpilotPosture);});
})();</script>`;
}

/** Inserts `markup` right after the opening <head> tag, or at the very start when there is none. */
export function insertAfterHead(html: string, markup: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return markup + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + markup + html.slice(at);
}

/**
 * Chrome paints an iframe opaque when the frame element's color scheme and the page's differ,
 * so the page and the iframe element (frame.ts) both declare "light dark" to stay transparent
 * over light and dark host pages alike (checked in headless Chromium).
 */
export const COLOR_SCHEME_META = '<meta name="color-scheme" content="light dark">';

/** The full page the iframe loads: policy and bridge first, then the cached page. */
export function framePage(cachedHtml: string, allowedOrigins: string[], values: BridgeValues): string {
  return insertAfterHead(cachedHtml, cspMeta(allowedOrigins) + bridgeScript(values) + COLOR_SCHEME_META);
}
