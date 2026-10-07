// Headless attempt against an instrumented key: run Cap's generated program in
// Node inside a hand-built mini-browser (vm context), then submit the result.
// No browser, no WebView — this is the "AI agent" case.
import vm from "node:vm";
import zlib from "node:zlib";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:3010";
const CORE =
  process.env.CAP_CORE ||
  new URL("../cap/standalone/node_modules/capjs-core/src/hashwx.js", import.meta.url).pathname;

const SETUP = `
(function () {
  class EventTarget {
    constructor() { this.__l = new Map(); }
    addEventListener(t, fn) { const a = this.__l.get(t) || []; this.__l.set(t, a); a.push(fn); }
    removeEventListener(t, fn) { const a = this.__l.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    dispatchEvent(e) { const a = this.__l.get(e.type) || []; for (const fn of a.slice()) fn(e); return true; }
  }
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }

  class Node extends EventTarget {}
  Object.defineProperty(Node.prototype, Symbol.toStringTag, { value: "Node" });

  class HTMLElement extends Node {
    constructor(tag) {
      super();
      this.tagName = (tag || "div").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this._text = "";
    }
    set innerText(v) { this._text = String(v); }
    get innerText() { return this._text; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    getBoundingClientRect() {
      const f = String(this.style.fontFamily || "default");
      let h = 0; for (let i = 0; i < f.length; i++) { h = (h * 31 + f.charCodeAt(i)) >>> 0; }
      // real font metrics are never whole pixels; geometry_stats() flags 5+ of them
      const w = 600 + (h % 900) + this._text.length * 3.37 + (h % 97) / 97;
      return { width: Math.round(w * 100) / 100, height: 72, top: 0, left: 0 };
    }
  }
  class Navigator {}
  class Document extends Node {
    constructor() {
      super();
      this.body = new HTMLElement("body");
      this.defaultView = null;
      this.documentElement = new HTMLElement("html");
      this.documentElement.getAttributeNames = () => [];
    }
    createElement(tag) { return new HTMLElement(tag); }
    hasFocus() { return true; }
  }
  class Window extends EventTarget {}
  class Screen { constructor() { this.width = 2560; this.height = 1440; } }

  Object.defineProperty(HTMLElement.prototype, Symbol.toStringTag, { value: "HTMLElement" });
  Object.defineProperty(Navigator.prototype, Symbol.toStringTag, { value: "Navigator" });
  Object.defineProperty(Window.prototype, Symbol.toStringTag, { value: "Window" });
  Object.defineProperty(Document.prototype, Symbol.toStringTag, { value: "HTMLDocument" });
  Object.defineProperty(CustomEvent.prototype, Symbol.toStringTag, { value: "CustomEvent" });

  class WebGLRenderingContext {}
  class HTMLCanvasElement {}
  class CanvasRenderingContext2D {}
  const NATIVE = new WeakSet();
  const nativeFn = (proto, name) => {
    const f = function () { return null; };
    Object.defineProperty(proto, name, { value: f, writable: true, configurable: true });
    NATIVE.add(f);
    return f;
  };
  nativeFn(WebGLRenderingContext.prototype, "getParameter");
  nativeFn(HTMLCanvasElement.prototype, "toDataURL");
  nativeFn(CanvasRenderingContext2D.prototype, "getImageData");

  const realToString = Function.prototype.toString;
  const patchedToString = function toString() {
    if (NATIVE.has(this)) return "function " + (this.name || "") + "() { [native code] }";
    return realToString.call(this);
  };
  NATIVE.add(patchedToString);
  Function.prototype.toString = patchedToString;

  // blockChecks walks Object.getOwnPropertyNames(navigator) and flags webdriver /
  // userAgent / productSub / plugins / ... — in a real browser those live on the
  // prototype as getters, so the shim must do the same.
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  for (const [k, v] of Object.entries({
    userAgent: UA, appVersion: UA.replace("Mozilla/", ""), productSub: "20030107",
    webdriver: false, platform: "Win32", vendor: "Google Inc.", product: "Gecko",
    languages: ["en-US", "en"], language: "en-US", plugins: { length: 5 },
    pdfViewerEnabled: true, deviceMemory: 8, oscpu: undefined, userAgentData: undefined,
    mimeTypes: undefined, hardwareConcurrency: 8,
  })) {
    Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
  }
  Object.defineProperty(Navigator.prototype, "permissions", {
    value: { query: nativeFn(Object.prototype, "query") }, configurable: true,
  });
  // the vm's own eval must stringify like native code
  NATIVE.add(eval);
  const nav = new Navigator();

  const win = new Window();
  win.window = win; win.self = win; win.navigator = nav; win.screen = new Screen();
  win.outerWidth = 1512; win.outerHeight = 945;
  win.innerWidth = 1512; win.innerHeight = 860;
  win.chrome = {};
  const doc = new Document();
  doc.defaultView = win;
  win.document = doc;

  win.parent = { postMessage: (msg) => { globalThis.__posted = msg; } };

  Error.prepareStackTrace = (err, frames) =>
    frames
      .filter((f) => String(f.getFileName()).startsWith("https://"))
      .map((f) => "    at " + (f.getFunctionName() || "anonymous") + " (" + f.getFileName() + ":" + (f.getLineNumber() || 0) + ")")
      .join("\\n");

  // NB: these are function-scope bindings inside the IIFE, so plain assignment
  // would only touch the local. They must land on the vm global object.
  // the env check demands globalThis === window === document.defaultView, so the
  // vm global itself becomes the window object (Window.prototype carries the toStringTag)
  Object.setPrototypeOf(globalThis, Window.prototype);
  globalThis.window = globalThis; globalThis.self = globalThis;
  doc.defaultView = globalThis;
  win.window = globalThis; win.self = globalThis; win.document = doc;
  globalThis.navigator = nav; globalThis.document = doc; globalThis.screen = win.screen;
  globalThis.outerWidth = win.outerWidth; globalThis.outerHeight = win.outerHeight;
  globalThis.innerWidth = win.innerWidth; globalThis.innerHeight = win.innerHeight;
  globalThis.parent = win.parent; globalThis.top = win;
  for (const k of ["HTMLElement", "Navigator", "Document", "Window", "Node", "EventTarget",
                   "CustomEvent", "WebGLRenderingContext", "HTMLCanvasElement", "CanvasRenderingContext2D"]) {
    globalThis[k] = eval(k);
  }
})();
`;

if (!isMainThread) {
  const { payload, budgetMs } = workerData;
  const core = await import(pathToFileURL(CORE).href);
  const state = await core.hashwxReady();
  const { c, d, n } = payload;
  const challenge = new Uint8Array(core.HASHWX_CHALLENGE_SIZE);
  for (let i = 0; i < 32; i++) challenge[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  const target = core.hashwxTarget(d);
  const w = BigInt(n);
  const t0 = Date.now();
  let hashes = 0;
  for (let block = 0n; ; block++) {
    const seed = core.hashwxSeed(challenge, block);
    const base = block * w;
    for (let k = 0n; k < w; k++) {
      hashes++;
      if (core.hashwxHash(state, seed, base + k) <= target) {
        parentPort.postMessage({ nonce: (base + k).toString(), hashes, ms: Date.now() - t0 });
        process.exit(0);
      }
    }
    if (Date.now() - t0 > budgetMs) { parentPort.postMessage({ timeout: true }); process.exit(0); }
  }
}

const [siteKey, secretKey] = process.argv.slice(2);

const cr = await fetch(`${BASE}/${siteKey}/challenge`, { method: "POST" });
const ch = await cr.json();
if (!ch.token) { console.error("challenge failed:", JSON.stringify(ch).slice(0, 300)); process.exit(1); }

console.log("challenge protos:", ch.challenges.map((c) => c.protocol).join(", "));
const t0 = Date.now();

const pow = ch.challenges.filter((c) => c.protocol === "hashwx");
const solved = await Promise.all(
  pow.map((c) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { payload: c.payload, budgetMs: 120000 } });
    w.once("message", res); w.once("error", rej);
  })),
);
console.log(`pow solved in ${Date.now() - t0}ms, hashes=${solved.map((s) => s.hashes).join("+")}`);

const instrEntry = ch.challenges.find((c) => c.protocol === "instrumentation");
const blob = ch.instrumentation || instrEntry?.payload?.blob;
let src = zlib.inflateRawSync(Buffer.from(blob, "base64")).toString("utf8");

// debug: number every `return null` so we can tell which env check bailed out
if (process.env.INSTR_DEBUG) {
  const pieces = src.split("return null");
  let idx = 0;
  src = pieces
    .map((p, i) =>
      i === pieces.length - 1
        ? p
        : p + `(globalThis.__fail=(globalThis.__fail||[]),globalThis.__fail.push(${idx++}),null)`,
    )
    .join("");
  globalThis.__snippets = pieces.map((p) => p.slice(-160).replace(/\s+/g, " "));
}
console.log(`instrumentation blob: ${blob.length}b -> ${src.length}B of JS`);

const ctx = vm.createContext({});
const opts = { filename: "https://trycap.dev/cap-instr.js" };
vm.runInContext(SETUP, ctx, opts);
vm.runInContext(src, ctx, opts);

let instr = null;
let instrError = null;
try {
  await vm.runInContext("window.onload()", ctx, opts);
  instr = vm.runInContext("globalThis.__posted && globalThis.__posted.result", ctx);
} catch (e) {
  instrError = String(e && e.message);
}
console.log("instrumentation:", instrError ? `THREW ${instrError}` : instr ? "produced a result" : "no result posted");
if (process.env.INSTR_DEBUG) {
  const fails = vm.runInContext("globalThis.__fail || []", ctx);
  console.log("failing 'return null' sites:", JSON.stringify(fails));
  for (const f of fails) console.log(`  #${f}: ...${globalThis.__snippets[f]}`);
}
if (instr) {
  console.log("  vars:", JSON.stringify(instr.state));
  console.log("  probe:", JSON.stringify(instr.p));
  const { detectAutomation } = await import(
    pathToFileURL(
      (process.env.CAP_CORE || new URL("../cap/standalone/node_modules/capjs-core/src/detect.js", import.meta.url).pathname).replace("hashwx.js", "detect.js"),
    ).href
  );
  const r = detectAutomation(instr.p, { fontStackCount: instr.p.fontWidths.length });
  console.log(`  local detect: pass=${r.pass} blockedBy=${JSON.stringify(r.blockedBy)}`);
  for (const c of r.checks) console.log(`    ${c.passed ? "ok  " : "FAIL"} ${c.id.padEnd(20)} ${c.detail}`);
}

// for format 2 the instrumentation result goes INSIDE the matching solutions entry
const solutions = ch.challenges.map((c, i) =>
  c.protocol === "hashwx" ? { nonce: Number(solved[i].nonce) } : { instr },
);
const body = { token: ch.token, solutions, ...(instr ? { instr } : {}) };
const rr = await fetch(`${BASE}/${siteKey}/redeem`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const res = await rr.json().catch(() => null);
console.log(`\nredeem -> ${rr.status}`, JSON.stringify(res).slice(0, 400));

if (res && res.success && secretKey) {
  const sv = await fetch(`${BASE}/${siteKey}/siteverify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: secretKey, response: res.token }),
  });
  console.log(`siteverify -> ${sv.status} ${JSON.stringify(await sv.json()).slice(0, 200)}`);
}