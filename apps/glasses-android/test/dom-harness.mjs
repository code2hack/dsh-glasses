// Shared jsdom 29.1.1 boundary harness for the M1 (#27) client DOM suites.
//
// Loads the REAL committed index.html + c0-core.js + snapshot-core.js + app.js
// assets into a fresh disposable jsdom runtime via JSDOM.fromFile, injecting a
// synthetic native bridge ONLY at the Android boundary. No hand-written DOM, no
// duplicate of production rendering code. Used by:
//   - m1-render.test.mjs        (fixture-driven runtime states / read-only)
//   - m1-narrow-edge.test.mjs   (real rc.2 bootstrap -> render)
import { JSDOM } from "jsdom";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML = join(HERE, "..", "app", "src", "main", "assets", "index.html");

/**
 * Boot one fresh disposable client DOM. `responses` is an array of
 * {status, body}; each /glasses/v1/bootstrap call consumes the next (the last
 * is clamped). Returns helpers to observe requests/traces/DOM/settled state.
 */
export async function bootClientDom({ responses, session = "default-session", endpoint = "http://dsh-render:7777" }) {
  const requests = [];
  const traces = [];
  let servedIndex = 0;
  const served = responses.slice();

  const dom = await JSDOM.fromFile(INDEX_HTML, {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const originalInfo = window.console.info.bind(window.console);
      window.console.info = (...args) => {
        traces.push(args.map(String).join(" "));
        originalInfo(...args);
      };
      window.GlassesBridge = {
        endpoint: () => endpoint,
        sessionId: () => session,
        configure: (base, token, sid) => { window.__configured = { base, sid }; return true; },
        fetch: (path, payload) => {
          requests.push({ path, hasBody: payload !== "" });
          const r = served[Math.min(servedIndex++, served.length - 1)];
          return JSON.stringify({ status: r.status, body: r.body });
        },
        openStream: () => { requests.push({ path: "OPEN_STREAM", hasBody: false }); },
        closeStream: () => {},
        clipboardText: () => "clip",
      };
    },
  });

  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);
  const settled = async (label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const gen = (w.c0DebugState && w.c0DebugState().generation) || "";
      const conn = String(($("conn") && $("conn").textContent) || "");
      if (gen !== "" || conn.startsWith("snapshot-rejected") || conn === "session-mismatch" || conn === "configure") return;
      await sleep(25);
    }
    throw new Error("runtime did not settle for " + label);
  };

  return {
    dom, w,
    requests: () => requests.map((r) => r.path),
    traces: () => traces.slice(),
    $,
    settled,
    setResponses(next) { served.length = 0; for (const r of next) served.push(r); },
  };
}

export function chatTexts(rt) {
  return [...rt.$("chat").querySelectorAll("article.message")].map((el) => ({
    role: el.querySelector(".role")?.textContent,
    body: el.querySelector(".body")?.textContent,
  }));
}
