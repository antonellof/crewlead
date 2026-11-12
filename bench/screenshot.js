#!/usr/bin/env node
// Serves a built app folder and takes headless Chrome screenshots at given
// film times, using the ?t=SECONDS parameter the benchmark prompt requires.
// Talks to Chrome over the DevTools protocol (built-in WebSocket, Node 22+),
// so the viewport is exact and console errors are captured.
//
//   node bench/screenshot.js <app dir> <out dir> [times, default 2,8,14,20,26]
//
// Writes t0002.png ... and console.txt (console messages and exceptions).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const [appArg, outArg, timesArg = "2,8,14,20,26"] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error("usage: node bench/screenshot.js <app dir> <out dir> [t1,t2,...]");
  process.exit(1);
}
const app = resolve(appArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const WIDTH = 1280;
const HEIGHT = 720;
const SETTLE_MS = 3000;

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

const log = [];
for (const t of timesArg.split(",")) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const lines = [];
  const onEvent = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled") {
      lines.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      lines.push(`EXCEPTION: ${d.exception?.description ?? d.text} (${d.url ?? ""}:${d.lineNumber})`);
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      lines.push(`log.error: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
    }
  };
  listeners.push(onEvent);
  await send("Runtime.enable", {}, sessionId);
  await send("Log.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = new Promise((r) => listeners.push((m) => m.sessionId === sessionId && m.method === "Page.loadEventFired" && r()));
  await send("Page.navigate", { url: `${base}/index.html?t=${t}` }, sessionId);
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 30_000))]);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const png = join(out, `t${String(t).padStart(4, "0")}.png`);
  writeFileSync(png, Buffer.from(data, "base64"));
  await send("Target.closeTarget", { targetId });
  listeners.splice(listeners.indexOf(onEvent), 1);
  log.push(`== t=${t}`, ...lines);
  console.log(`t=${t} -> ${png}${lines.some((l) => /EXCEPTION|error/.test(l)) ? "  (errors, see console.txt)" : ""}`);
}
writeFileSync(join(out, "console.txt"), log.join("\n") + "\n");

ws.close();
const exited = new Promise((r) => browser.on("close", r));
browser.kill();
await exited;
server.close();
rmSync(profile, { recursive: true, force: true });
