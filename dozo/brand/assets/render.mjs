// Rasterises SVG masters to exact-size PNGs with headless Brave over CDP (Node built-ins only).
// Brave is taken from $E2E_BROWSER_PATH or the macOS default. Each job draws the SVG on a canvas
// of the real pixel size, so there is no window, no screenshot and no resampling.
// Usage: node render.mjs raster.json   job: {svg, w, h, out, bg?, scheme?}  (paths relative to the json)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jobsFile = path.resolve(process.argv[2]);
const dir = path.dirname(jobsFile);
const jobs = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
const brave =
  process.env.E2E_BROWSER_PATH ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const port = 9300 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dozo-render-"));
const child = spawn(
  brave,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-networking",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const done = async (code) => {
  child.kill();
  await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(code);
};

try {
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
        (t) => t.type === "page",
      );
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!page) throw new Error("browser did not start");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const j of jobs) {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: j.scheme ?? "light" }],
    });
    const svg = fs.readFileSync(path.join(dir, j.svg), "utf8");
    const r = await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{
        const img=new Image(); img.width=${j.w}; img.height=${j.h};
        await new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error('svg load failed'));
          img.src=URL.createObjectURL(new Blob([${JSON.stringify(svg)}],{type:'image/svg+xml'}));});
        const cv=document.createElement('canvas'); cv.width=${j.w}; cv.height=${j.h}; const x=cv.getContext('2d');
        ${j.bg ? `x.fillStyle=${JSON.stringify(j.bg)}; x.fillRect(0,0,${j.w},${j.h});` : ""}
        x.drawImage(img,0,0,${j.w},${j.h}); return cv.toDataURL('image/png'); })()`,
    });
    if (r.exceptionDetails)
      throw new Error(`${j.svg}: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    fs.mkdirSync(path.dirname(path.join(dir, j.out)), { recursive: true });
    fs.writeFileSync(path.join(dir, j.out), Buffer.from(r.result.value.split(",")[1], "base64"));
    console.log(`wrote ${j.out} ${j.w}x${j.h}`);
  }
  await done(0);
} catch (e) {
  console.error(e.message);
  await done(1);
}
