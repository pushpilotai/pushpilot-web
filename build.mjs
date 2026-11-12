// Builds the ES module, the script-tag file and the service worker with esbuild.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const shared = { bundle: true, minify: true, target: "es2020", define: { __SDK_VERSION__: JSON.stringify(version) }, logLevel: "info" };

await build({ ...shared, entryPoints: ["src/index.ts"], format: "esm", outfile: "dist/pushpilot.mjs" });
await build({ ...shared, entryPoints: ["src/index.ts"], format: "iife", globalName: "PushPilot", outfile: "dist/pushpilot.js" });
await build({ ...shared, entryPoints: ["src/sw.ts"], format: "iife", outfile: "dist/pushpilot-sw.js" });
