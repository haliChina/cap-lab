// Mini-browser: enough of a DOM/window surface to execute Cap's generated
// instrumentation program outside a browser (Node + node:vm).
import vm from "node:vm";
import zlib from "node:zlib";

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
})();`;

const VM_OPTS = { filename: "https://trycap.dev/cap-instr.js" };

// blob -> { i, state, p, ts } exactly like the widget produces, or throws
export function runInstrumentation(blob) {
  const src = zlib.inflateRawSync(Buffer.from(blob, "base64")).toString("utf8");
  const ctx = vm.createContext({});
  vm.runInContext(SETUP, ctx, VM_OPTS);
  vm.runInContext(src, ctx, VM_OPTS);
  return vm.runInContext("window.onload()", VM_OPTS && ctx, VM_OPTS).then(
    () => vm.runInContext("globalThis.__posted && globalThis.__posted.result", ctx),
  );
}

// same input, but reports why the program bailed out instead of silently returning
export function runInstrumentationDebug(blob) {
  const raw = zlib.inflateRawSync(Buffer.from(blob, "base64")).toString("utf8");
  const pieces = raw.split("return null");
  let idx = 0;
  const src = pieces
    .map((p, i) => (i === pieces.length - 1 ? p : p + `(globalThis.__fail=(globalThis.__fail||[]),globalThis.__fail.push(${idx++}),null)`))
    .join("");
  const snippets = pieces.map((p) => p.slice(-160).replace(/\s+/g, " "));
  const ctx = vm.createContext({});
  vm.runInContext(SETUP, ctx, VM_OPTS);
  vm.runInContext(src, ctx, VM_OPTS);
  return vm.runInContext("window.onload()", ctx, VM_OPTS).then(() => ({
    result: vm.runInContext("globalThis.__posted && globalThis.__posted.result", ctx),
    failed: vm.runInContext("globalThis.__fail || []", ctx),
    snippets,
  }));
}
