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
 *   5. Launches `ecu-netsim` on a random monitor port, switches the capture
 *      source via Settings to the simulator link, asserts live simulator
 *      frames (with handshake-derived endpoint names) render end to end,
 *      the degraded Trace link chip is absent once Connected, and the
 *      Network Connection panel shows the sim source + Connected.
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
  const cells = table ? [...table.querySelectorAll("tbody tr td")] : [];
  const totalAttr = table ? table.getAttribute("data-row-total") : null;
  return {
    viewPresent: !!q("view-trace"),
    tablePresent: !!table,
    // Model size (not Virtuoso's viewport-mounted tr count).
    rowCount: totalAttr != null ? Number(totalAttr) : 0,
    visibleRowCount: table ? table.querySelectorAll("tbody tr").length : 0,
    emptyShown: !!q("trace-empty"),
    mode: table ? table.getAttribute("data-trace-mode") : null,
    // Fingerprint of visible cell text — changes when Fixed rewrites in place.
    cellFingerprint: cells.map((c) => c.textContent || "").join("|").slice(0, 800),
  };
})()`;

const OPEN_DISPLAY_SETTINGS_PROBE = `(() => {
  const btn = document.querySelector('[data-testid="trace-display-settings-btn"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const CLICK_SEQUENTIAL_MODE_PROBE = `(() => {
  const radio = document.querySelector('[data-testid="trace-mode-sequential"]');
  if (!radio) return false;
  const input = radio.matches("input") ? radio : radio.querySelector("input");
  (input || radio).click();
  return true;
})()`;

const CLICK_FIXED_MODE_PROBE = `(() => {
  const radio = document.querySelector('[data-testid="trace-mode-fixed"]');
  if (!radio) return false;
  const input = radio.matches("input") ? radio : radio.querySelector("input");
  (input || radio).click();
  return true;
})()`;

const TRACE_MODE_PROBE = `(() => {
  const table = document.querySelector('[data-testid="trace-table"]');
  return table ? table.getAttribute("data-trace-mode") : null;
})()`;

// MUI Select opens on mousedown of its combobox; options render in a portal.
const OPEN_SETTINGS_SOURCE_SELECT_PROBE = `(() => {
  const root = document.querySelector('[data-testid="settings-source-select"]');
  const combo = root ? root.querySelector('[role="combobox"]') : null;
  if (!combo) return false;
  combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return true;
})()`;

// React-controlled input: use the native value setter so the change is seen.
function setSimAddrProbe(addr) {
  return `(() => {
    const root = document.querySelector('[data-testid="settings-sim-addr"]');
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
  const text = cells.map((c) => c.textContent || "");
  const names = ["camera", "radar", "lidar", "dynamics", "fusion"];
  const totalAttr = table ? table.getAttribute("data-row-total") : null;
  return {
    rowCount: totalAttr != null ? Number(totalAttr) : (table ? table.querySelectorAll("tbody tr").length : 0),
    // Healthy Connected link must NOT show the Trace degraded chip (§4.3).
    chipLabel: chip ? chip.textContent : null,
    chipAbsent: !chip,
    endpointNameSeen: text.some((t) => names.some((n) => t.includes(n))),
    // All three simulated traffic classes must actually render as rows.
    protocolsSeen: ["SOME/IP", "SD", "gPTP"].filter((p) =>
      text.some((t) => t === p)),
  };
})()`;

const NETWORK_CONNECTION_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const panel = q("network-connection-panel");
  const kind = q("network-source-kind");
  const addr = q("network-source-addr");
  const sessionChip = q("network-session-chip");
  const linkChip = q("network-link-chip");
  return {
    panelPresent: !!panel,
    sourceKind: kind ? kind.textContent : null,
    sourceAddr: addr ? addr.textContent : null,
    sessionLabel: sessionChip ? sessionChip.textContent : null,
    linkLabel: linkChip ? linkChip.textContent : null,
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

    // Phase 2 — global run gate + Trace Fixed default (SRS §4.3 / §5.2).
    // Trace is the default view; still click the rail entry when it is ready.
    await waitFor(
      () => session.eval(clickProbe("nav-trace")),
      10_000,
      "nav-trace clickable",
    );
    await waitFor(async () => {
      const s = await session.eval(TRACE_STATE_PROBE);
      return s.viewPresent ? s : null;
    }, 10_000, "trace view mounted");

    // Stillness while stopped: zero rows and no growth over ~2 s.
    {
      const a = await session.eval(TRACE_STATE_PROBE);
      await sleep(2000);
      const b = await session.eval(TRACE_STATE_PROBE);
      if (!a.emptyShown || a.rowCount !== 0)
        fail(`expected empty trace while stopped, got ${JSON.stringify(a)}`);
      if (!b.emptyShown || b.rowCount !== 0)
        fail(`trace grew while stopped: ${JSON.stringify(b)}`);
      console.log("stillness: ok (0 rows over 2 s while stopped)");
    }

    // Start via the app-bar run control (session owner), not the Trace mirror.
    if (!(await session.eval(clickProbe("appbar-run-btn"))))
      fail("could not click appbar-run-btn");
    const fixedLive = await waitFor(async () => {
      const s = await session.eval(TRACE_STATE_PROBE);
      return s.tablePresent && s.rowCount > 0 ? s : null;
    }, 15_000, "frames to appear after app-bar Start");
    if (fixedLive.mode !== "fixed")
      fail(`expected Fixed default mode, got "${fixedLive.mode}"`);
    console.log("fixed:", JSON.stringify({
      rowCount: fixedLive.rowCount,
      mode: fixedLive.mode,
    }));

    // Fixed mode: row count stays near the key count while cell text rewrites.
    {
      const samples = [];
      for (let i = 0; i < 4; i += 1) {
        await sleep(400);
        samples.push(await session.eval(TRACE_STATE_PROBE));
      }
      const counts = samples.map((s) => s.rowCount);
      const maxC = Math.max(...counts);
      const minC = Math.min(...counts);
      // Keyed collapse: count should stay stable (small band), not race toward
      // hundreds of chronological rows.
      if (maxC > 64)
        fail(`Fixed row count blew up (expected keyed collapse): ${counts.join(",")}`);
      if (maxC - minC > 8)
        fail(`Fixed row count unstable: ${counts.join(",")}`);
      const fingerprints = new Set(samples.map((s) => s.cellFingerprint));
      if (fingerprints.size < 2)
        fail("Fixed mode did not rewrite row texts over time");
      console.log(`fixed rewrite: counts=[${counts.join(",")}] fingerprints=${fingerprints.size}`);
    }

    // Switch to Sequential via the display-settings popover and prove growth.
    if (!(await session.eval(OPEN_DISPLAY_SETTINGS_PROBE)))
      fail("could not open display-settings popover");
    await waitFor(
      () => session.eval(CLICK_SEQUENTIAL_MODE_PROBE),
      5_000,
      "Sequential mode radio in the popover",
    );
    const modeAfter = await waitFor(async () => {
      const m = await session.eval(TRACE_MODE_PROBE);
      return m === "sequential" ? m : null;
    }, 5_000, "table data-trace-mode=sequential");
    console.log(`mode after popover: ${modeAfter}`);
    const seqStart = await session.eval(TRACE_STATE_PROBE);
    await sleep(1500);
    const seqLater = await session.eval(TRACE_STATE_PROBE);
    if (!(seqLater.rowCount > seqStart.rowCount))
      fail(
        `Sequential did not grow: ${seqStart.rowCount} → ${seqLater.rowCount}`,
      );
    console.log(`sequential growth: ${seqStart.rowCount} → ${seqLater.rowCount}`);
    const trace = seqLater;

    // Phase 3 — the simulator link streams real ecu-netsim traffic into Trace.
    // Stop via the Trace mirror (same session), choose Interface in Settings.
    if (!(await session.eval(clickProbe("trace-capture-btn"))))
      fail("could not stop the devgen capture via Trace mirror");
    // Source controls unlock only while stopped — wait a beat for the stop.
    await sleep(300);
    if (!(await session.eval(clickProbe("nav-settings"))))
      fail("could not navigate to Settings");
    await waitFor(async () => {
      const ok = await session.eval(
        `!!document.querySelector('[data-testid="settings-source-select"]')`,
      );
      return ok ? true : null;
    }, 10_000, "settings source select");
    if (!(await session.eval(OPEN_SETTINGS_SOURCE_SELECT_PROBE)))
      fail("could not open the Settings source select");
    await waitFor(
      () => session.eval(clickProbe("settings-source-option-sim")),
      5_000,
      "sim option in the Settings source menu",
    );
    await waitFor(
      () => session.eval(setSimAddrProbe(`127.0.0.1:${SIM_PORT}`)),
      5_000,
      "settings sim address field",
    );
    if (!(await session.eval(clickProbe("nav-trace"))))
      fail("could not return to Trace after Settings");
    await waitFor(async () => {
      const s = await session.eval(TRACE_STATE_PROBE);
      return s.viewPresent ? s : null;
    }, 10_000, "trace view after Settings");
    // Fixed mode keeps one row per key so SOME/IP + SD + gPTP stay visible.
    // Switch while the Sequential table is still mounted (empty state has no mode attr).
    if (!(await session.eval(OPEN_DISPLAY_SETTINGS_PROBE)))
      fail("could not open display-settings for Fixed before sim");
    await waitFor(
      () => session.eval(CLICK_FIXED_MODE_PROBE),
      5_000,
      "Fixed mode radio before sim",
    );
    await waitFor(async () => {
      const m = await session.eval(TRACE_MODE_PROBE);
      return m === "fixed" ? m : null;
    }, 5_000, "table data-trace-mode=fixed before sim");
    if (!(await session.eval(clickProbe("trace-clear-btn"))))
      fail("could not clear devgen rows before the sim phase");
    // Start sim via the app-bar again (prove both entry points).
    if (!(await session.eval(clickProbe("appbar-run-btn"))))
      fail("could not start the sim capture via appbar-run-btn");
    // Healthy Connected → Trace degraded chip absent (§4.3).
    let lastSim = null;
    const protocolsRendered = new Set();
    const sim = await waitFor(async () => {
      const s = await session.eval(SIM_STATE_PROBE);
      lastSim = s;
      for (const p of s.protocolsSeen) protocolsRendered.add(p);
      return s.rowCount > 0 &&
        s.chipAbsent &&
        s.endpointNameSeen &&
        protocolsRendered.size === 3
        ? s
        : null;
    }, 20_000, "simulator frames (SOME/IP + SD + gPTP) + absent degraded chip + endpoint names in Trace").catch((err) => {
      console.error(
        "last sim state:", JSON.stringify(lastSim),
        "protocols rendered so far:", [...protocolsRendered].join(", ") || "none",
      );
      throw err;
    });
    console.log("sim:", JSON.stringify(sim));

    // Network Connection panel must show the live sim source + Connected.
    if (!(await session.eval(clickProbe("nav-network"))))
      fail("could not navigate to Network");
    const network = await waitFor(async () => {
      const n = await session.eval(NETWORK_CONNECTION_PROBE);
      return n.panelPresent &&
        n.sourceKind === "Simulator link" &&
        n.linkLabel === "Connected" &&
        n.sessionLabel && n.sessionLabel.includes("running")
        ? n
        : null;
    }, 10_000, "Network Connection panel sim source + Connected");
    console.log("network:", JSON.stringify(network));
    if (network.sourceAddr && !network.sourceAddr.includes(String(SIM_PORT)))
      fail(`Network addr "${network.sourceAddr}" missing sim port ${SIM_PORT}`);

    console.log(
      `PASS — devgen ${trace.rowCount} rows (Fixed→Sequential); simulator link ${sim.rowCount} rows, ` +
        `degraded chip absent, protocols [${[...protocolsRendered].join(", ")}], ` +
        `endpoint names rendered; Network Connection "${network.sourceKind}" / "${network.linkLabel}"`,
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
