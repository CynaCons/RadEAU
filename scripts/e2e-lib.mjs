/**
 * Shared helpers for RadEAU CDP e2e harnesses (smoke + release).
 */

import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const VITE_URL = "http://localhost:1420";

/** True when the process tree rooted at `pid` was terminated. */
export function killTree(pid) {
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

export function spawnHidden(command, options = {}) {
  return spawn(command, {
    shell: true,
    windowsHide: true,
    stdio: "ignore",
    ...options,
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function reachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

/** Resolve when a TCP connect to 127.0.0.1:port succeeds within timeoutMs. */
export async function tcpReachable(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

/** True when nothing accepts connections on the port (within a short window). */
export async function portClosed(port, samples = 3) {
  for (let i = 0; i < samples; i += 1) {
    if (await tcpReachable(port, 400)) return false;
    await sleep(100);
  }
  return true;
}

export function launchApp(exePath, cdpPort, userDataDir, cwd = repoRoot) {
  return spawnHidden(`"${exePath}"`, {
    cwd,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      WEBVIEW2_USER_DATA_FOLDER: userDataDir,
    },
  });
}

export async function cdpPageTarget(cdpPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      );
      if (page) return page;
    } catch {
      /* CDP not up yet */
    }
    await sleep(300);
  }
  throw new Error(`no CDP page target on port ${cdpPort}`);
}

export class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  /** Subscribes to a CDP event (e.g. "Tracing.dataCollected"). */
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(cb);
    return () => this.handlers.get(method)?.delete(cb);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), {
        once: true,
      });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const cb of this.handlers.get(msg.method)) cb(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `page threw: ${res.exceptionDetails.exception?.description ?? expression}`,
      );
    }
    return res.result.value;
  }

  close() {
    this.ws.close();
  }
}

export async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

export function clickProbe(testId) {
  return `(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`;
}

export function setTextFieldProbe(testId, value) {
  return `(() => {
    const root = document.querySelector('[data-testid="${testId}"]');
    const input = root ? root.querySelector("input") : null;
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

export const SHELL_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
           r.bottom > 0 && r.right > 0 &&
           r.top < window.innerHeight && r.left < window.innerWidth;
  };
  return {
    title: document.title,
    readyState: document.readyState,
    viewport: [window.innerWidth, window.innerHeight],
    appBarVisible: visible(q("app-bar")),
    navRailVisible: visible(q("nav-rail")),
  };
})()`;

export const TRACE_STATE_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const table = q("trace-table");
  const cells = table ? [...table.querySelectorAll("tbody tr td")] : [];
  const totalAttr = table ? table.getAttribute("data-row-total") : null;
  return {
    viewPresent: !!q("view-trace"),
    tablePresent: !!table,
    rowCount: totalAttr != null ? Number(totalAttr) : 0,
    visibleRowCount: table ? table.querySelectorAll("tbody tr").length : 0,
    emptyShown: !!q("trace-empty"),
    mode: table ? table.getAttribute("data-trace-mode") : null,
    cellFingerprint: cells.map((c) => c.textContent || "").join("|").slice(0, 800),
  };
})()`;

export const OPEN_SETTINGS_SOURCE_SELECT_PROBE = `(() => {
  const root = document.querySelector('[data-testid="settings-source-select"]');
  const combo = root ? root.querySelector('[role="combobox"]') : null;
  if (!combo) return false;
  combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return true;
})()`;

export const DEPS_PROBE = `(() => {
  const panel = document.querySelector('[data-testid="settings-dependencies-panel"]');
  const ids = ["npcap", "libpcap", "vxlapi", "vector-driver"];
  const allowed = new Set([
    "Installed", "Missing", "Incompatible", "Blocked", "N/A",
  ]);
  const rows = ids.map((id) => {
    const chip = document.querySelector('[data-testid="settings-dep-status-' + id + '"]');
    const label = chip ? (chip.textContent || "").trim() : null;
    const head = label ? label.split("·")[0].trim() : null;
    return { id, label, head, ok: head ? allowed.has(head) : false };
  });
  return {
    panelPresent: !!panel,
    rows,
    allOk: rows.every((r) => r.ok),
  };
})()`;

export const APPBAR_RUN_LABEL_PROBE = `(() => {
  const btn = document.querySelector('[data-testid="appbar-run-btn"]');
  if (!btn) return null;
  return {
    label: (btn.getAttribute("aria-label") || btn.textContent || "").trim(),
    pressed: btn.getAttribute("aria-pressed"),
  };
})()`;

export const NETWORK_EOF_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  return {
    linkLabel: q("network-link-chip")?.textContent?.trim() || null,
    linkDetail: q("network-link-detail")?.textContent?.trim() || null,
    sourceKind: q("network-source-kind")?.textContent?.trim() || null,
  };
})()`;

export function readTauriVersion() {
  const conf = JSON.parse(
    readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf-8"),
  );
  return String(conf.version);
}

export function portableDir(version = readTauriVersion()) {
  return join(repoRoot, "dist-portable", `RadEAU-${version}-win64`);
}
