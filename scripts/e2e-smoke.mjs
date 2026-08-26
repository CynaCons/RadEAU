/**
 * E2E smoke harness — launches the real RadEAU binary, attaches to its
 * WebView over the Chrome DevTools Protocol, and asserts the app is actually
 * visible and streaming (PRD §9.3; PLAN.md v0.1.2/v0.2.1 E2E bootstrap).
 *
 * What it does:
 *   1. Ensures the vite dev server is up on 1420 (debug builds load devUrl).
 *   2. Ensures the debug binary exists (cargo build if missing).
 *   3. Launches the executable hidden, on a random CDP port and a per-run
 *      WebView2 profile under the OS temp dir.
 *   4. Over CDP: asserts the shell (app bar + nav rail) is rendered inside
 *      the viewport, navigates to Trace, starts the capture, and asserts
 *      frames are flowing through the real Rust pipeline.
 *   5. Launches `ecu-netsim` on a random monitor port, switches the Trace
 *      source to the simulator link, and asserts live simulator frames
 *      (with handshake-derived endpoint names) render end to end.
 *   6. Cleans up every process and the temp profile; exits non-zero on any
 *      failed assertion.
 *
 * All child processes spawn with windowsHide — no terminal windows pop.
 *
 * Run: npm run test:e2e
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const VITE_URL = "http://localhost:1420";
const EXE = join(repoRoot, "target", "debug", "radeau.exe");
const NETSIM_EXE = join(repoRoot, "target", "debug", "ecu-netsim.exe");
const CDP_PORT = 9300 + Math.floor(Math.random() * 4000);
const SIM_PORT = 15560 + Math.floor(Math.random() * 2000);

/** True when the process tree rooted at `pid` was terminated. */
function killTree(pid) {
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

function spawnHidden(command, options = {}) {
  return spawn(command, {
    shell: true,
    windowsHide: true,
    stdio: "ignore",
    ...options,
  });
}

async function reachable(url, timeoutMs) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureVite() {
  if (await reachable(VITE_URL, 1000)) return null;
  const child = spawnHidden("npm run dev", { cwd: repoRoot });
  if (!(await reachable(VITE_URL, 30_000))) {
    killTree(child.pid);
    throw new Error("vite dev server did not come up on 1420");
  }
  return child;
}

async function ensureBinary() {
  if (existsSync(EXE) && existsSync(NETSIM_EXE)) return;
  console.log("debug binaries missing — building (this can take a while)…");
  await new Promise((resolve, reject) => {
    const child = spawnHidden("cargo build --workspace", { cwd: repoRoot });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`cargo build exited ${code}`)),
    );
  });
}

/** Resolve when a TCP connect to 127.0.0.1:port succeeds within timeoutMs. */
async function tcpReachable(port, timeoutMs) {
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

async function launchNetsim() {
  const child = spawnHidden(`"${NETSIM_EXE}" --monitor-port ${SIM_PORT} --seed 7`, {
    cwd: repoRoot,
  });
  if (!(await tcpReachable(SIM_PORT, 15_000))) {
    killTree(child.pid);
    throw new Error(`ecu-netsim monitor link did not come up on ${SIM_PORT}`);
  }
  return child;
}

function launchApp(userDataDir) {
  const child = spawnHidden(`"${EXE}"`, {
    cwd: repoRoot,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: userDataDir,
    },
  });
  return child;
}

async function cdpPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
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
  throw new Error(`no CDP page target on port ${CDP_PORT}`);
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
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

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// --- page-side probes -------------------------------------------------------

const SHELL_PROBE = `(() => {
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

function clickProbe(testId) {
  return `(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return false;
    el.click();
    return true;
  })()`;
}

const TRACE_STATE_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const table = q("trace-table");
  return {
    viewPresent: !!q("view-trace"),
    tablePresent: !!table,
    rowCount: table ? table.querySelectorAll("tbody tr").length : 0,
    emptyShown: !!q("trace-empty"),
  };
})()`;

// MUI Select opens on mousedown of its combobox; options render in a portal.
const OPEN_SOURCE_SELECT_PROBE = `(() => {
  const root = document.querySelector('[data-testid="trace-source-select"]');
  const combo = root ? root.querySelector('[role="combobox"]') : null;
  if (!combo) return false;
  combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return true;
})()`;

// React-controlled input: use the native value setter so the change is seen.
function setSimAddrProbe(addr) {
  return `(() => {
    const root = document.querySelector('[data-testid="trace-sim-addr"]');
    const input = root ? root.querySelector("input") : null;
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(addr)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

const SIM_STATE_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const table = q("trace-table");
  const chip = q("trace-link-chip");
  const cells = table ? [...table.querySelectorAll("tbody tr td")] : [];
  const names = ["camera", "radar", "lidar", "dynamics", "fusion"];
  return {
    rowCount: table ? table.querySelectorAll("tbody tr").length : 0,
    chipLabel: chip ? chip.textContent : null,
    endpointNameSeen: cells.some((c) =>
      names.some((n) => (c.textContent || "").includes(n))),
  };
})()`;

// --- scenario ---------------------------------------------------------------

async function main() {
  const viteProc = await ensureVite();
  await ensureBinary();
  const netsimProc = await launchNetsim();

  const userDataDir = mkdtempSync(join(tmpdir(), "radeau-e2e-"));
  const appProc = launchApp(userDataDir);
  let session = null;
  let failures = 0;

  const fail = (msg) => {
    failures += 1;
    console.error(`FAIL ${msg}`);
  };

  try {
    const page = await cdpPageTarget(45_000);
    session = new CdpSession(page.webSocketDebuggerUrl);
    await session.open();

    // Phase 1 — the app is visibly there. Wait for React to actually mount
    // (the webview reports readyState complete on about:blank too).
    const shell = await waitFor(async () => {
      const s = await session.eval(SHELL_PROBE);
      return s.appBarVisible && s.navRailVisible ? s : null;
    }, 30_000, "app shell to mount");
    console.log("shell:", JSON.stringify(shell));
    if (shell.title !== "RadEAU") fail(`title is "${shell.title}", expected RadEAU`);
    if (!shell.appBarVisible) fail("app bar not visible in viewport");
    if (!shell.navRailVisible) fail("nav rail not visible in viewport");
    if (shell.viewport[0] < 1024 || shell.viewport[1] < 700)
      fail(`viewport too small: ${shell.viewport}`);

    // Phase 2 — Trace streams live frames from the Rust dev generator.
    if (!(await session.eval(clickProbe("nav-trace")))) fail("could not click nav-trace");
    await waitFor(async () => {
      const s = await session.eval(TRACE_STATE_PROBE);
      return s.viewPresent ? s : null;
    }, 10_000, "trace view mounted");

    if (!(await session.eval(clickProbe("trace-capture-btn"))))
      fail("could not click trace-capture-btn");
    const trace = await waitFor(async () => {
      const s = await session.eval(TRACE_STATE_PROBE);
      return s.tablePresent && s.rowCount > 0 ? s : null;
    }, 15_000, "frames to appear in the trace table");
    console.log("trace:", JSON.stringify(trace));

    // Phase 3 — the simulator link streams real ecu-netsim traffic into Trace.
    if (!(await session.eval(clickProbe("trace-capture-btn"))))
      fail("could not stop the devgen capture");
    if (!(await session.eval(OPEN_SOURCE_SELECT_PROBE)))
      fail("could not open the source select");
    await waitFor(
      () => session.eval(clickProbe("trace-source-option-sim")),
      5_000,
      "sim option in the source menu",
    );
    await waitFor(
      () => session.eval(setSimAddrProbe(`127.0.0.1:${SIM_PORT}`)),
      5_000,
      "sim address field",
    );
    if (!(await session.eval(clickProbe("trace-clear-btn"))))
      fail("could not clear devgen rows before the sim phase");
    if (!(await session.eval(clickProbe("trace-capture-btn"))))
      fail("could not start the sim capture");
    const sim = await waitFor(async () => {
      const s = await session.eval(SIM_STATE_PROBE);
      return s.rowCount > 0 && s.chipLabel === "Connected" && s.endpointNameSeen
        ? s
        : null;
    }, 20_000, "simulator frames + Connected chip + endpoint names in Trace");
    console.log("sim:", JSON.stringify(sim));
    console.log(
      `PASS — devgen ${trace.rowCount} rows; simulator link ${sim.rowCount} rows, ` +
        `chip "${sim.chipLabel}", endpoint names rendered`,
    );
  } catch (err) {
    failures += 1;
    console.error("FAIL", err?.message ?? err);
  } finally {
    session?.close();
    killTree(appProc.pid);
    if (netsimProc) killTree(netsimProc.pid);
    if (viteProc) killTree(viteProc.pid);
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* profile dir may linger while WebView2 flushes; temp cleans it up */
    }
  }

  if (failures > 0) process.exit(1);
}

main();
