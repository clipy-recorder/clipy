import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const desktopDir = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(desktopDir, "package.json"));
const esbuild = require("esbuild");

function createMinimalDom() {
  class FakeNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.childNodes = [];
      this.parentNode = null;
      this.ownerDocument = null;
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const idx = this.childNodes.indexOf(ref);
      if (idx === -1) this.childNodes.push(child);
      else this.childNodes.splice(idx, 0, child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) this.childNodes.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
    get firstChild() {
      return this.childNodes[0] ?? null;
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[idx + 1] ?? null;
    }
  }

  class FakeElement extends FakeNode {
    constructor(tagName, ownerDocument) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this.nodeName = this.tagName;
      this.namespaceURI = "http://www.w3.org/1999/xhtml";
      this.ownerDocument = ownerDocument;
      this.attributes = new Map();
      this.style = {};
      this.disabled = false;
      this.type = "";
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    removeAttribute(name) {
      this.attributes.delete(name);
    }
    set className(v) {
      this.setAttribute("class", v);
    }
    get className() {
      return this.getAttribute("class") ?? "";
    }
    set textContent(v) {
      this.childNodes = v ? [new FakeText(String(v), this.ownerDocument)] : [];
      if (this.childNodes[0]) this.childNodes[0].parentNode = this;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
    querySelectorAll(selector) {
      const results = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1) {
            if (selector === '[role="alert"]' && child.getAttribute("role") === "alert") {
              results.push(child);
            } else if (selector === '[role="status"]' && child.getAttribute("role") === "status") {
              results.push(child);
            }
            visit(child);
          }
        }
      };
      visit(this);
      return results;
    }
  }

  class FakeText extends FakeNode {
    constructor(data, ownerDocument) {
      super(3);
      this.data = data;
      this.ownerDocument = ownerDocument;
    }
    set nodeValue(v) {
      this.data = String(v);
    }
    get nodeValue() {
      return this.data;
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this.data = String(v);
    }
  }

  class FakeComment extends FakeNode {
    constructor(data, ownerDocument) {
      super(8);
      this.data = data;
      this.ownerDocument = ownerDocument;
    }
    get textContent() {
      return "";
    }
  }

  class FakeDocumentFragment extends FakeNode {
    constructor(ownerDocument) {
      super(11);
      this.ownerDocument = ownerDocument;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
  }

  const document = {
    nodeType: 9,
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, document),
    createElementNS: (_ns, tag) => new FakeElement(tag, document),
    createTextNode: (text) => new FakeText(String(text), document),
    createComment: (text) => new FakeComment(String(text), document),
    createDocumentFragment: () => new FakeDocumentFragment(document),
    addEventListener() {},
    removeEventListener() {},
  };

  return { document, FakeNode, FakeElement };
}

test("LocalModePanel clears stale refresh error after a subsequent refresh succeeds", async (t) => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "clipy-panel-test-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const entryFile = path.join(tempDir, "entry.tsx");
  const outFile = path.join(tempDir, "LocalModePanel.mjs");
  const panelPath = path.join(desktopDir, "src/components/LocalModePanel.tsx");
  writeFileSync(
    entryFile,
    `import * as React from "react";
import { createRoot } from "react-dom/client";
import LocalModePanel from ${JSON.stringify(panelPath)};
export { React, createRoot, LocalModePanel };
`,
  );

  await esbuild.build({
    entryPoints: [entryFile],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    nodePaths: [path.join(desktopDir, "node_modules")],
    banner: {
      js: `import { createRequire as __createRequire } from "node:module"; const require = __createRequire(${JSON.stringify(path.join(desktopDir, "package.json"))});`,
    },
    plugins: [
      {
        name: "mock-desktop-deps",
        setup(build) {
          build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
            path: "tauri-core",
            namespace: "mock",
          }));
          build.onResolve({ filter: /^@tauri-apps\/plugin-clipboard-manager$/ }, () => ({
            path: "tauri-clipboard",
            namespace: "mock",
          }));
          build.onResolve({ filter: /^use-intl$/ }, () => ({
            path: "use-intl",
            namespace: "mock",
          }));
          build.onResolve({ filter: /\.\.\/lib\/platform$/ }, () => ({
            path: "platform",
            namespace: "mock",
          }));
          build.onResolve({ filter: /\.\.\/lib\/edition$/ }, () => ({
            path: "edition",
            namespace: "mock",
          }));
          build.onLoad({ filter: /^tauri-core$/, namespace: "mock" }, () => ({
            contents: `export const invoke = (...args) => globalThis.__mockInvoke(...args);`,
            loader: "js",
          }));
          build.onLoad({ filter: /^tauri-clipboard$/, namespace: "mock" }, () => ({
            contents: `export const writeText = async () => {};`,
            loader: "js",
          }));
          build.onLoad({ filter: /^use-intl$/, namespace: "mock" }, () => ({
            contents: `
              export const useTranslations = () => (key, vars) =>
                vars ? key + ":" + JSON.stringify(vars) : key;
              export const useFormatter = () => ({ dateTime: () => "Jan 1, 12:00" });
            `,
            loader: "js",
          }));
          build.onLoad({ filter: /^platform$/, namespace: "mock" }, () => ({
            contents: `export const deviceName = "Mac"; export const isWindows = false;`,
            loader: "js",
          }));
          build.onLoad({ filter: /^edition$/, namespace: "mock" }, () => ({
            contents: `export const LOCAL_EDITION = true;`,
            loader: "js",
          }));
        },
      },
    ],
  });
  await esbuild.stop();

  const { document, FakeNode, FakeElement } = createMinimalDom();
  class FakeShadowRoot {}
  const prevGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    ShadowRoot: globalThis.ShadowRoot,
    MessageChannel: globalThis.MessageChannel,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    __mockInvoke: globalThis.__mockInvoke,
  };

  let pollCallback = null;
  class FakeHTMLIFrameElement {}
  const fakeWindow = {
    document,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: FakeHTMLIFrameElement,
    ShadowRoot: FakeShadowRoot,
    setInterval: (fn) => {
      pollCallback = fn;
      return 1;
    },
    clearInterval: () => {},
  };
  document.defaultView = fakeWindow;

  globalThis.window = fakeWindow;
  globalThis.document = document;
  globalThis.Node = FakeNode;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.ShadowRoot = FakeShadowRoot;
  const OrigMessageChannel = prevGlobals.MessageChannel;
  globalThis.MessageChannel = class UnrefMessageChannel {
    constructor() {
      const ch = new OrigMessageChannel();
      ch.port1.unref();
      ch.port2.unref();
      return ch;
    }
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const { React, createRoot, LocalModePanel } = await import(pathToFileURL(outFile).href);

  const container = document.createElement("div");
  let root;

  t.after(() => {
    if (root) {
      React.act(() => {
        root.unmount();
      });
    }
    globalThis.window = prevGlobals.window;
    globalThis.document = prevGlobals.document;
    globalThis.Node = prevGlobals.Node;
    globalThis.Element = prevGlobals.Element;
    globalThis.HTMLElement = prevGlobals.HTMLElement;
    globalThis.ShadowRoot = prevGlobals.ShadowRoot;
    globalThis.MessageChannel = prevGlobals.MessageChannel;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevGlobals.IS_REACT_ACT_ENVIRONMENT;
    globalThis.__mockInvoke = prevGlobals.__mockInvoke;
  });

  // 1. Initial call rejects with "Read failed".
  let callCount = 0;
  globalThis.__mockInvoke = async (cmd) => {
    assert.equal(cmd, "list_local_recordings");
    callCount += 1;
    if (callCount === 1) {
      throw new Error("Read failed");
    }
    return [
      {
        id: "rec-1",
        stage: "ready",
        message: "",
        directory: "/tmp/rec-1",
        arec_path: "/tmp/rec-1/recording.arec",
        updated_at_ms: 1700000000000,
        bytes: 2048,
        kept: false,
        expires_at_ms: null,
      },
    ];
  };

  await React.act(async () => {
    root = createRoot(container);
    root.render(React.createElement(LocalModePanel, { signedIn: true, listAll: true }));
  });

  const initialAlerts = container.querySelectorAll('[role="alert"]');
  assert.equal(initialAlerts.length, 1);
  assert.match(initialAlerts[0].textContent, /Read failed/);
  assert.equal(container.querySelectorAll('[role="status"]').length, 0);

  // 2. Subsequent poll succeeds: stale alert must disappear and recording must render.
  assert.equal(typeof pollCallback, "function");
  await React.act(async () => {
    pollCallback();
  });

  assert.equal(container.querySelectorAll('[role="alert"]').length, 0);
  const statuses = container.querySelectorAll('[role="status"]');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].textContent, "status.ready");
});
