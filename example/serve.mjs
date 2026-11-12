// Serves the example page and the built SDK on http://localhost:8080 (PORT to change it).
// The worker is served from the site root so its scope covers the whole page.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const files = {
  "/": ["example/index.html", "text/html"],
  "/pushpilot.mjs": ["dist/pushpilot.mjs", "text/javascript"],
  "/pushpilot-sw.js": ["dist/pushpilot-sw.js", "text/javascript"],
};
const port = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
  const file = files[new URL(req.url, "http://localhost").pathname];
  if (!file) return res.writeHead(404).end("not found");
  res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" });
  res.end(await readFile(new URL(file[0], root)));
}).listen(port, "localhost", () => console.log(`PushPilot web example on http://localhost:${port}`));
