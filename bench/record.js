#!/usr/bin/env node
// Records a built pop-up book app as numbered PNG frames, for a video.
// Replaces the page clock (performance.now, Date.now, requestAnimationFrame)
// before the app loads, then steps it one frame at a time. Every frame is
// rendered at its exact film time however slow the machine is, so two apps
// recorded this way line up frame for frame.
//
//   node bench/record.js <app dir> <out dir> [fps, default 24] [seconds, default 30]
//
// Writes f00000.png ... Turn frames into a video with ffmpeg, for example:
//   ffmpeg -framerate 24 -i out/f%05d.png -pix_fmt yuv420p film.mp4

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const [appArg, outArg, fpsArg = "24", secondsArg = "30"] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error("usage: node bench/record.js <app dir> <out dir> [fps] [seconds]");
  process.exit(1);
}
const fps = Number(fpsArg);
const frames = Math.round(Number(secondsArg) * fps);
const app = resolve(appArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const WIDTH = 1280;
const HEIGHT = 720;
const SETTLE_MS = 2000;

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/favicon.ico") return res.writeHead(204).end();
  let file = normalize(join(app, path));
  if (!file.startsWith(app)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "crewlead-shot-"));
const browser = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--use-angle=metal", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--no-first-run", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((res, rej) => {
  let buf = "";
  browser.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) res(m[1]);
  });
  browser.on("close", () => rej(new Error(`chrome exited before DevTools was ready:\n${buf}`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// Installed before any page script runs. The app's render loop only advances
// when __setTime is called.
const CLOCK = `(() => {
  let now = 0;
  let queue = [];
  const epoch = Date.now();
  performance.now = () => now;
  Date.now = () => epoch + now;
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  window.__waiting = () => queue.length;
  window.__setTime = (ms) => { now = ms; const q = queue; queue = []; for (const cb of q) cb(now); };
})();`;

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const errors = [];
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
});
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await send("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK }, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
const loaded = new Promise((r) => listeners.push((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired" && r()));
await send("Page.navigate", { url: `${base}/index.html` }, sessionId);
await Promise.race([loaded, new Promise((r) => setTimeout(r, 30_000))]);
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
for (let i = 0; i < 300 && !(await evaluate("window.__waiting()")); i++) await new Promise((r) => setTimeout(r, 100));
if (!(await evaluate("window.__waiting()"))) throw new Error("the app never started its render loop");
await new Promise((r) => setTimeout(r, SETTLE_MS));

for (let i = 0; i < frames; i++) {
  await evaluate(`window.__setTime(${(i * 1000) / fps})`);
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(out, `f${String(i).padStart(5, "0")}.png`), Buffer.from(data, "base64"));
  if (i % fps === 0) process.stdout.write(`${i / fps}s `);
}
console.log(`\n${frames} frames -> ${out}${errors.length ? `\nerrors:\n${errors.join("\n")}` : ""}`);

ws.close();
const exited = new Promise((r) => browser.on("close", r));
browser.kill();
await exited;
server.close();
rmSync(profile, { recursive: true, force: true });
