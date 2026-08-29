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
  // --udp-target is harmless for the sim-link phase and required for live loopback.
  const child = spawnHidden(
    `"${NETSIM_EXE}" --monitor-port ${SIM_PORT} --seed 7 --udp-target 127.0.0.1`,
    {
      cwd: repoRoot,
    },
  );
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

const OPEN_SETTINGS_LIVE_INTERFACE_PROBE = `(() => {
  const root = document.querySelector('[data-testid="settings-live-interface"]');
  const combo = root ? root.querySelector('[role="combobox"]') : null;
  if (!combo) return false;
  combo.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return true;
})()`;

/** True when the Physical interface option is present and disabled (Npcap missing). */
const LIVE_OPTION_STATE_PROBE = `(() => {
  const opt = document.querySelector('[data-testid="settings-source-option-live"]');
  if (!opt) return { present: false, disabled: true };
  const disabled =
    opt.getAttribute("aria-disabled") === "true" ||
    opt.classList.contains("Mui-disabled") ||
    opt.hasAttribute("disabled");
  return { present: true, disabled };
})()`;

/** Pick the first live interface option whose label or value matches /loopback/i. */
const CLICK_LIVE_LOOPBACK_OPTION_PROBE = `(() => {
  const options = [...document.querySelectorAll('[data-testid^="settings-live-option-"]')];
  for (const opt of options) {
    const text = (opt.textContent || "").trim();
    const value = opt.getAttribute("data-value") || "";
    if (/loopback/i.test(text) || /loopback/i.test(value)) {
      opt.click();
      return { ok: true, text, value, testId: opt.getAttribute("data-testid") };
    }
  }
  return {
    ok: false,
    count: options.length,
    labels: options.map((o) => (o.textContent || "").trim().slice(0, 80)),
  };
})()`;

const LIVE_TRACE_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const table = q("trace-table");
  if (!table) return { rowCount: 0, someipOrSd: false, source127: false };
  const rows = [...table.querySelectorAll("tbody tr")].filter(
    (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
  );
  let someipOrSd = false;
  let source127 = false;
  for (const row of rows) {
    const cells = [...row.querySelectorAll("td")].map((c) => (c.textContent || "").trim());
    // Protocol is typically after expand/time/dir; scan all cells.
    if (cells.some((t) => t === "SOME/IP" || t === "SD")) someipOrSd = true;
    if (cells.some((t) => t.includes("127.0.0.1"))) source127 = true;
  }
  const totalAttr = table.getAttribute("data-row-total");
  return {
    rowCount: totalAttr != null ? Number(totalAttr) : rows.length,
    someipOrSd,
    source127,
  };
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

function setTextFieldProbe(testId, value) {
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

const DEPS_PROBE = `(() => {
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

const DIAG_PROBE = `(() => {
  const field = document.querySelector('[data-testid="settings-diag-report-field"]');
  const input = field
    ? (field.querySelector("textarea") || field.querySelector("input"))
    : null;
  const report = input ? (input.value || "") : "";
  const logEl = document.querySelector('[data-testid="settings-log-path"]');
  const logText = logEl ? (logEl.textContent || "") : "";
  return {
    report,
    hasRadeau: /RadEAU/i.test(report),
    hasLogPath: /log/i.test(report) || /log path/i.test(logText),
    logText,
  };
})()`;

const APPBAR_RUN_LABEL_PROBE = `(() => {
  const btn = document.querySelector('[data-testid="appbar-run-btn"]');
  if (!btn) return null;
  return {
    label: (btn.getAttribute("aria-label") || btn.textContent || "").trim(),
    pressed: btn.getAttribute("aria-pressed"),
  };
})()`;

const NETWORK_EOF_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  return {
    linkLabel: q("network-link-chip")?.textContent?.trim() || null,
    linkDetail: q("network-link-detail")?.textContent?.trim() || null,
    sourceKind: q("network-source-kind")?.textContent?.trim() || null,
  };
})()`;

const FIRST_TIME_CELL_PROBE = `(() => {
  const table = document.querySelector('[data-testid="trace-table"]');
  if (!table) return null;
  const row = [...table.querySelectorAll("tbody tr")].find(
    (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
  );
  if (!row) return null;
  const cells = row.querySelectorAll("td");
  // Time is column index 1 (expand, time, …).
  return cells[1] ? (cells[1].textContent || "").trim() : null;
})()`;

const CLICK_WALL_TIME_PROBE = `(() => {
  const radio = document.querySelector('[data-testid="trace-time-mode-wall"]');
  if (!radio) return false;
  if (radio.getAttribute("aria-disabled") === "true" || radio.classList.contains("Mui-disabled"))
    return false;
  const input = radio.matches("input") ? radio : radio.querySelector("input");
  if (input && input.disabled) return false;
  (input || radio).click();
  return true;
})()`;

const PCAP_FIXTURE = join(repoRoot, "fixtures", "pcap", "sensor-fusion-5s.pcap");

const SIM_STATE_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const table = q("trace-table");
  const chip = q("trace-link-chip");
  const cells = table ? [...table.querySelectorAll("tbody tr td")] : [];
  const text = cells.map((c) => c.textContent || "");
  const names = ["camera", "radar", "lidar", "dynamics", "fusion"];
  const totalAttr = table ? table.getAttribute("data-row-total") : null;
  // Dir is column index 2 (expand, time, dir, …).
  const dirCells = table
    ? [...table.querySelectorAll("tbody tr")]
        .filter((r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"))
        .map((r) => (r.querySelectorAll("td")[2]?.textContent || "").trim())
    : [];
  return {
    rowCount: totalAttr != null ? Number(totalAttr) : (table ? table.querySelectorAll("tbody tr").length : 0),
    // Healthy Connected link must NOT show the Trace degraded chip (§4.3).
    chipLabel: chip ? chip.textContent : null,
    chipAbsent: !chip,
    endpointNameSeen: text.some((t) => names.some((n) => t.includes(n))),
    // Cumulative protocol set — ARP / IPv6 / Malformed arrive on a slower cadence.
    protocolsSeen: ["SOME/IP", "SD", "gPTP", "ARP", "IPv6", "Malformed"].filter((p) =>
      text.some((t) => t === p)),
    lidarClustersSeen: text.some((t) => t.includes("LidarClusters")),
    allDirRx: dirCells.length > 0 && dirCells.every((d) => d === "Rx"),
  };
})()`;

const NETWORK_CONNECTION_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const panel = q("network-connection-panel");
  const kind = q("network-source-kind");
  const addr = q("network-source-addr");
  const sessionChip = q("network-session-chip");
  const linkChip = q("network-link-chip");
  const received = q("network-stat-received");
  const droppedChip = q("trace-dropped-chip");
  const receivedText = received ? (received.textContent || "") : "";
  const receivedMatch = receivedText.match(/(\\d[\\d,]*)/);
  const receivedN = receivedMatch ? Number(receivedMatch[1].replace(/,/g, "")) : 0;
  return {
    panelPresent: !!panel,
    sourceKind: kind ? kind.textContent : null,
    sourceAddr: addr ? addr.textContent : null,
    sessionLabel: sessionChip ? sessionChip.textContent : null,
    linkLabel: linkChip ? linkChip.textContent : null,
    receivedN,
    droppedChipAbsent: !droppedChip,
  };
})()`;

// --- Trace filter probes (v0.1.7 / SRS §5.2) --------------------------------

/** PROTO_GPTP = 2 — option keys are the numeric protocol class. */
const FILTER_PROTO_GPTP_KEY = "2";
/** LidarClusters service 0x1103 method 0x8001 → `${sv}:${m}`. */
const FILTER_LIDAR_NAME_KEY = "4355:32769";

function openFilterBtnProbe(testId) {
  return `(() => {
    if (document.querySelector('[data-testid="trace-filter-popover"]')) return true;
    const btn = document.querySelector('[data-testid="${testId}"]');
    if (!btn) return false;
    btn.click();
    return !!document.querySelector('[data-testid="trace-filter-popover"]');
  })()`;
}

const FILTER_SELECT_ALL_PROBE = `(() => {
  const btn = document.querySelector('[data-testid="trace-filter-select-all"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const FILTER_APPLY_PROBE = `(() => {
  const btn = document.querySelector('[data-testid="trace-filter-apply"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

function filterToggleOptionProbe(key) {
  return `(() => {
    const opt = document.querySelector('[data-testid="trace-filter-option-${key}"]');
    if (!opt) return { ok: false, reason: "option missing" };
    const input = opt.querySelector('input[type="checkbox"]');
    if (!input) return { ok: false, reason: "checkbox input missing" };
    input.click();
    return { ok: true, checked: input.checked };
  })()`;
}

function filterSearchProbe(text) {
  return `(() => {
    const root = document.querySelector('[data-testid="trace-filter-search"]');
    const input = root ? root.querySelector("input") : null;
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

const FILTER_STATE_PROBE = `(() => {
  const q = (t) => document.querySelector('[data-testid="' + t + '"]');
  const table = q("trace-table");
  const chip = q("trace-filtered-chip");
  const emptyFiltered = q("trace-empty-filtered");
  const rows = table
    ? [...table.querySelectorAll("tbody tr")].filter(
        (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
      )
    : [];
  // Protocol is column index 4 (expand, time, dir, source, protocol, …).
  const protocolCells = rows.map((r) => (r.querySelectorAll("td")[4]?.textContent || "").trim());
  // Name is column index 6.
  const nameCells = rows.map((r) => (r.querySelectorAll("td")[6]?.textContent || "").trim());
  const chipText = chip ? (chip.textContent || "").trim() : null;
  let shown = null;
  let total = null;
  if (chipText) {
    const m = chipText.match(/Filtered\\s*·\\s*([\\d,]+)\\s*\\/\\s*([\\d,]+)/);
    if (m) {
      shown = Number(m[1].replace(/,/g, ""));
      total = Number(m[2].replace(/,/g, ""));
    }
  }
  const totalAttr = table ? table.getAttribute("data-row-total") : null;
  return {
    tablePresent: !!table,
    emptyFiltered: !!emptyFiltered,
    emptyFilteredText: emptyFiltered ? (emptyFiltered.textContent || "").trim() : null,
    chipPresent: !!chip,
    chipText,
    shown,
    total,
    rowCount: totalAttr != null ? Number(totalAttr) : rows.length,
    protocolCells,
    nameCells,
    allProtocolGptp: protocolCells.length > 0 && protocolCells.every((p) => p === "gPTP"),
    allNamesLidarClusters:
      nameCells.length > 0 && nameCells.every((n) => n.includes("LidarClusters")),
    protoBtnPressed: q("trace-filter-btn-protocol")?.getAttribute("aria-pressed") === "true",
    nameBtnPressed: q("trace-filter-btn-name")?.getAttribute("aria-pressed") === "true",
    dirBtnPressed: q("trace-filter-btn-dir")?.getAttribute("aria-pressed") === "true",
    popoverOpen: !!q("trace-filter-popover"),
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
    // Allow ~25 s so ARP (2 s), ICMPv6 (5 s), and a runt (10 s) all appear.
    let lastSim = null;
    const protocolsRendered = new Set();
    const sim = await waitFor(async () => {
      const s = await session.eval(SIM_STATE_PROBE);
      lastSim = s;
      for (const p of s.protocolsSeen) protocolsRendered.add(p);
      return s.rowCount > 0 &&
        s.chipAbsent &&
        s.endpointNameSeen &&
        protocolsRendered.size === 6 &&
        s.lidarClustersSeen &&
        s.allDirRx
        ? s
        : null;
    }, 25_000, "simulator frames (SOME/IP+SD+gPTP+ARP+IPv6+Malformed) + LidarClusters + Dir Rx + absent degraded chip").catch((err) => {
      console.error(
        "last sim state:", JSON.stringify(lastSim),
        "protocols rendered so far:", [...protocolsRendered].join(", ") || "none",
      );
      throw err;
    });
    console.log("sim:", JSON.stringify(sim));

    // Network Connection panel must show the live sim source + Connected + stats.
    if (!(await session.eval(clickProbe("nav-network"))))
      fail("could not navigate to Network");
    const network = await waitFor(async () => {
      const n = await session.eval(NETWORK_CONNECTION_PROBE);
      return n.panelPresent &&
        n.sourceKind === "Simulator link" &&
        n.linkLabel === "Connected" &&
        n.sessionLabel && n.sessionLabel.includes("running") &&
        n.receivedN > 0 &&
        n.droppedChipAbsent
        ? n
        : null;
    }, 10_000, "Network Connection panel sim source + Connected + received>0 + no Dropped chip");
    console.log("network:", JSON.stringify(network));
    if (network.sourceAddr && !network.sourceAddr.includes(String(SIM_PORT)))
      fail(`Network addr "${network.sourceAddr}" missing sim port ${SIM_PORT}`);

    // Phase 4 — expanding a live simulator frame dissects it layer by layer.
    if (!(await session.eval(clickProbe("nav-trace")))) fail("could not return to Trace");
    await waitFor(
      () => session.eval(`(() => {
        const btn = document.querySelector('[data-testid^="trace-expand-btn-"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`),
      5_000,
      "an expandable trace row",
    );
    const detail = await waitFor(async () => {
      const d = await session.eval(`(() => {
        const panel = document.querySelector('[data-testid^="trace-detail-"]');
        if (!panel) return null;
        const text = panel.textContent || "";
        return {
          hasEthernet: text.includes("Ethernet II"),
          layerCount: panel.querySelectorAll('[data-testid^="trace-detail-layer-"]').length,
        };
      })()`);
      return d && d.hasEthernet && d.layerCount >= 2 ? d : null;
    }, 10_000, "dissection panel with Ethernet II + at least 2 layers");
    console.log("dissection:", JSON.stringify(detail));

    // VLAN-tagged LidarClusters: expand and assert 802.1Q precedes IPv4.
    await session.eval(`(() => {
      const open = document.querySelector('[data-testid^="trace-expand-btn-"][aria-expanded="true"]');
      if (open) open.click();
      return true;
    })()`);
    await waitFor(async () => {
      const r = await session.eval(`(() => {
        const rows = [...document.querySelectorAll("tbody tr")].filter(
          (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
        );
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          const name = (cells[6]?.textContent || "").trim();
          if (name.includes("LidarClusters")) {
            const btn = row.querySelector('[data-testid^="trace-expand-btn-"]');
            if (!btn) return { ok: false, reason: "no expand" };
            btn.click();
            return { ok: true };
          }
        }
        return { ok: false, reason: "LidarClusters row not found" };
      })()`);
      return r && r.ok ? r : null;
    }, 10_000, "LidarClusters row to expand");
    const vlanDetail = await waitFor(async () => {
      const d = await session.eval(`(() => {
        const panel = document.querySelector('[data-testid^="trace-detail-"]');
        if (!panel) return null;
        if (panel.querySelector('[data-testid="trace-detail-loading"]')) return null;
        const layers = [...panel.querySelectorAll('[data-testid^="trace-detail-layer-"]')]
          .map((el) => {
            const title = el.querySelector('[data-testid^="trace-detail-layer-title-"]');
            return (title ? title.textContent : el.textContent || "").trim();
          });
        // Fallback: scan layer headings from panel text order.
        const text = panel.textContent || "";
        const qIdx = text.indexOf("802.1Q");
        const ipIdx = text.search(/IPv4|Internet Protocol Version 4/);
        return {
          layers,
          has8021Q: qIdx >= 0,
          qBeforeIp: qIdx >= 0 && ipIdx >= 0 && qIdx < ipIdx,
        };
      })()`);
      return d && d.has8021Q && d.qBeforeIp ? d : null;
    }, 10_000, "LidarClusters dissection with 802.1Q before IPv4");
    console.log("vlan dissection:", JSON.stringify(vlanDetail));

    // Phase 5 — catalog-driven Trace content (names + clean dissections + decode).
    // Ensure the catalog is loaded (core may auto-load at startup; rail toggles).
    {
      const pressed = await session.eval(`(() => {
        const btn = document.querySelector('[data-testid="trace-catalog-btn"]');
        return btn ? btn.getAttribute("aria-pressed") === "true" : false;
      })()`);
      if (!pressed) {
        // The rail button opens the catalog popover; Decode is its switch.
        if (!(await session.eval(clickProbe("trace-catalog-btn"))))
          fail("could not click trace-catalog-btn to open the catalog popover");
        await waitFor(
          () => session.eval(clickProbe("trace-catalog-decode")),
          5_000,
          "catalog popover Decode switch",
        );
        await session.eval(`(() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return true;
        })()`);
        await waitFor(async () => {
          const ok = await session.eval(`(() => {
            const btn = document.querySelector('[data-testid="trace-catalog-btn"]');
            return btn && btn.getAttribute("aria-pressed") === "true";
          })()`);
          return ok ? true : null;
        }, 10_000, "catalog rail badge loaded (aria-pressed)");
      }
    }

    // Collapse any open dissection before the content probes.
    await session.eval(`(() => {
      const open = document.querySelector('[data-testid^="trace-expand-btn-"][aria-expanded="true"]');
      if (open) open.click();
      return true;
    })()`);

    // 5a — catalog names appear on Fixed-mode rows (poll cumulatively).
    const namesSeen = { objectList: false, fusionStats: false };
    const nameProbe = await waitFor(async () => {
      const s = await session.eval(`(() => {
        const table = document.querySelector('[data-testid="trace-table"]');
        const cells = table ? [...table.querySelectorAll("tbody tr td")] : [];
        const text = cells.map((c) => (c.textContent || "").trim());
        return {
          objectList: text.some((t) => t === "CameraObjects.ObjectList"),
          fusionStats: text.some((t) => t.includes("FusionStats")),
        };
      })()`);
      if (s.objectList) namesSeen.objectList = true;
      if (s.fusionStats) namesSeen.fusionStats = true;
      return namesSeen.objectList && namesSeen.fusionStats ? namesSeen : null;
    }, 20_000, "catalog names CameraObjects.ObjectList + FusionStats").catch((err) => {
      console.error("catalog names so far:", JSON.stringify(namesSeen));
      throw err;
    });
    console.log("catalog names:", JSON.stringify(nameProbe));

    // 5b — no malformed layers across one frame of each protocol class.
    const PROTO_EXPAND_PROBE = (proto) => `(() => {
      const rows = [...document.querySelectorAll("tbody tr")].filter(
        (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
      );
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if ((cells[4]?.textContent || "").trim() === ${JSON.stringify(proto)}) {
          const btn = row.querySelector('[data-testid^="trace-expand-btn-"]');
          if (!btn) return { ok: false, reason: "no expand btn" };
          btn.click();
          return { ok: true, idx: (btn.getAttribute("data-testid") || "").replace("trace-expand-btn-", "") };
        }
      }
      return { ok: false, reason: "protocol row not found" };
    })()`;

    const COLLAPSE_EXPANDED_PROBE = `(() => {
      const open = document.querySelector('[data-testid^="trace-expand-btn-"][aria-expanded="true"]');
      if (open) open.click();
      return true;
    })()`;

    const DISSECT_TEXT_PROBE = `(() => {
      const panel = document.querySelector('[data-testid^="trace-detail-"]');
      if (!panel) return null;
      // Prefer the ready panel body over a loading/empty flash.
      if (panel.querySelector('[data-testid="trace-detail-loading"]')) return null;
      if (panel.querySelector('[data-testid="trace-detail-empty"]')) {
        return { text: panel.textContent || "", layerCount: 0, empty: true };
      }
      return {
        text: panel.textContent || "",
        layerCount: panel.querySelectorAll('[data-testid^="trace-detail-layer-"]').length,
        empty: false,
      };
    })()`;

    const malformedByProto = {};
    for (const proto of ["SOME/IP", "SD", "gPTP"]) {
      await session.eval(COLLAPSE_EXPANDED_PROBE);
      const expanded = await waitFor(async () => {
        const r = await session.eval(PROTO_EXPAND_PROBE(proto));
        return r && r.ok ? r : null;
      }, 10_000, `${proto} row to expand`);
      const dissected = await waitFor(async () => {
        const d = await session.eval(DISSECT_TEXT_PROBE);
        return d && !d.empty && d.layerCount >= 1 ? d : null;
      }, 10_000, `${proto} dissection panel`);
      const hasMalformed = /malformed/i.test(dissected.text);
      malformedByProto[proto] = hasMalformed;
      if (hasMalformed)
        fail(`${proto} dissection contained "malformed" (idx ${expanded.idx})`);
      await session.eval(COLLAPSE_EXPANDED_PROBE);
    }
    console.log("no-malformed:", JSON.stringify(malformedByProto));

    // 5c — decoded signal table on a SOME/IP event dissection.
    await session.eval(COLLAPSE_EXPANDED_PROBE);
    const someIpEventExpand = `(() => {
      const rows = [...document.querySelectorAll("tbody tr")].filter(
        (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
      );
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        const proto = (cells[4]?.textContent || "").trim();
        const type = (cells[7]?.textContent || "").trim();
        if (proto === "SOME/IP" && (type === "Notification" || type === "Event")) {
          const btn = row.querySelector('[data-testid^="trace-expand-btn-"]');
          if (!btn) return { ok: false };
          btn.click();
          return { ok: true };
        }
      }
      return { ok: false };
    })()`;
    await waitFor(async () => {
      const r = await session.eval(someIpEventExpand);
      return r && r.ok ? r : null;
    }, 10_000, "SOME/IP Notification row to expand");

    const SIGNAL_ALLOWLIST = [
      "FrameCounter", "ObjectCount", "ExposureTime",
      "TargetCount", "NearestRange", "NearestSpeed",
      "ClusterCount", "PointCount", "MeanIntensity",
      "VehicleSpeed", "YawRate", "AccelX",
      "TrackCount", "QualityMean", "LeadRange", "LeadSpeed",
      "InputLatencyCam", "MatchedTracks", "UnmatchedTracks",
    ];
    const UNIT_ALLOWLIST = ["m/s", "ms", "m", "%"];

    const decoded = await waitFor(async () => {
      const d = await session.eval(`(() => {
        const table = document.querySelector('[data-testid^="trace-decoded-"]');
        if (!table) return null;
        const rows = [...table.querySelectorAll('[data-testid^="trace-decoded-row-"]')];
        const names = rows.map((r) => (r.children[0]?.textContent || "").trim());
        const units = [...table.querySelectorAll('[data-testid^="trace-decoded-unit-"]')]
          .map((c) => (c.textContent || "").trim());
        const scaled = [...table.querySelectorAll('[data-testid^="trace-decoded-scaled-"]')]
          .map((c) => (c.textContent || "").trim());
        return { names, units, scaled, rowCount: rows.length };
      })()`);
      return d && d.rowCount > 0 ? d : null;
    }, 10_000, "decoded signal table on SOME/IP event");

    const knownSignal = decoded.names.some((n) => SIGNAL_ALLOWLIST.includes(n));
    if (!knownSignal)
      fail(`decoded table had no allowlisted signal name: ${decoded.names.join(",")}`);
    const knownUnit = decoded.units.some((u) => UNIT_ALLOWLIST.includes(u));
    if (!knownUnit)
      fail(`decoded table had no allowlisted unit: ${decoded.units.join(",")}`);
    for (const s of decoded.scaled) {
      const n = Number(s);
      if (!Number.isFinite(n))
        fail(`decoded scaled cell is not a finite number: "${s}"`);
    }
    console.log("decoded:", JSON.stringify({
      names: decoded.names,
      units: decoded.units,
      scaled: decoded.scaled,
    }));

    // Phase 6 — per-column Trace filtering (§5.2 / v0.1.7), sim still streaming.
    await session.eval(COLLAPSE_EXPANDED_PROBE);

    // 6a — Protocol → gPTP only.
    await waitFor(
      () => session.eval(openFilterBtnProbe("trace-filter-btn-protocol")),
      5_000,
      "Protocol filter popover",
    );
    if (!(await session.eval(FILTER_SELECT_ALL_PROBE)))
      fail("Protocol filter: could not deselect-all");
    {
      const toggled = await session.eval(filterToggleOptionProbe(FILTER_PROTO_GPTP_KEY));
      if (!toggled || !toggled.ok)
        fail(`Protocol filter: could not select gPTP (${JSON.stringify(toggled)})`);
    }
    if (!(await session.eval(FILTER_APPLY_PROBE)))
      fail("Protocol filter: Apply failed");
    const gptpFilter = await waitFor(async () => {
      const s = await session.eval(FILTER_STATE_PROBE);
      return s.chipPresent && s.allProtocolGptp && s.shown != null && s.total != null && s.shown < s.total
        ? s
        : null;
    }, 10_000, "Protocol=gPTP filter: all cells gPTP + Filtered chip shown<total");
    console.log("filter protocol=gPTP:", JSON.stringify({
      shown: gptpFilter.shown,
      total: gptpFilter.total,
      rowCount: gptpFilter.rowCount,
      protoBtnPressed: gptpFilter.protoBtnPressed,
    }));

    // 6b — Direction deselect-all → filtered empty state (empty selection is allowed).
    await waitFor(
      () => session.eval(openFilterBtnProbe("trace-filter-btn-dir")),
      5_000,
      "Direction filter popover",
    );
    if (!(await session.eval(FILTER_SELECT_ALL_PROBE)))
      fail("Direction filter: could not deselect-all");
    if (!(await session.eval(FILTER_APPLY_PROBE)))
      fail("Direction filter: Apply (empty) failed");
    const emptyFiltered = await waitFor(async () => {
      const s = await session.eval(FILTER_STATE_PROBE);
      return s.emptyFiltered ? s : null;
    }, 10_000, "filtered empty state after Direction deselect-all");
    if (!/No rows match the active filters/i.test(emptyFiltered.emptyFilteredText || ""))
      fail(`unexpected filtered empty copy: "${emptyFiltered.emptyFilteredText}"`);
    console.log("filter dir=empty:", JSON.stringify({
      emptyFiltered: emptyFiltered.emptyFiltered,
      chipPresent: emptyFiltered.chipPresent,
    }));

    // 6c — Direction select-all clears that column → matching rows return (Protocol still gPTP).
    await waitFor(
      () => session.eval(openFilterBtnProbe("trace-filter-btn-dir")),
      5_000,
      "Direction filter popover (clear)",
    );
    if (!(await session.eval(FILTER_SELECT_ALL_PROBE)))
      fail("Direction filter: could not select-all");
    if (!(await session.eval(FILTER_APPLY_PROBE)))
      fail("Direction filter: Apply (select-all) failed");
    await waitFor(async () => {
      const s = await session.eval(FILTER_STATE_PROBE);
      return !s.emptyFiltered && s.tablePresent && s.rowCount > 0 && s.allProtocolGptp ? s : null;
    }, 10_000, "rows return after Direction select-all");

    // Clear Protocol before Name — LidarClusters is SOME/IP; AND with gPTP yields nothing.
    await waitFor(
      () => session.eval(openFilterBtnProbe("trace-filter-btn-protocol")),
      5_000,
      "Protocol filter popover (clear)",
    );
    if (!(await session.eval(FILTER_SELECT_ALL_PROBE)))
      fail("Protocol filter: could not select-all to clear");
    if (!(await session.eval(FILTER_APPLY_PROBE)))
      fail("Protocol filter: Apply (clear) failed");

    // 6d — Name search "Lidar", select only LidarClusters.
    await waitFor(
      () => session.eval(openFilterBtnProbe("trace-filter-btn-name")),
      5_000,
      "Name filter popover",
    );
    if (!(await session.eval(filterSearchProbe("Lidar"))))
      fail("Name filter: search field missing");
    if (!(await session.eval(FILTER_SELECT_ALL_PROBE)))
      fail("Name filter: could not deselect-all");
    {
      const toggled = await session.eval(filterToggleOptionProbe(FILTER_LIDAR_NAME_KEY));
      if (!toggled || !toggled.ok)
        fail(`Name filter: could not select LidarClusters (${JSON.stringify(toggled)})`);
    }
    if (!(await session.eval(FILTER_APPLY_PROBE)))
      fail("Name filter: Apply failed");
    const nameFilter = await waitFor(async () => {
      const s = await session.eval(FILTER_STATE_PROBE);
      return s.chipPresent && s.allNamesLidarClusters ? s : null;
    }, 10_000, "Name=LidarClusters filter: all Name cells contain LidarClusters");
    console.log("filter name=LidarClusters:", JSON.stringify({
      shown: nameFilter.shown,
      total: nameFilter.total,
      nameCells: nameFilter.nameCells.slice(0, 8),
    }));

    // 6e — select-all on Name (and Protocol if still active) → chip absent.
    // Protocol was cleared before the Name step so LidarClusters (SOME/IP) can
    // surface; only re-touch a column when its glyph is still pressed — opening
    // an already-clear column and hitting select-all would deselect everything
    // and Apply would re-activate an empty filter.
    async function clearColumnIfActive(btnTestId, label) {
      const pressed = await session.eval(`(() => {
        const btn = document.querySelector('[data-testid="${btnTestId}"]');
        return btn && btn.getAttribute("aria-pressed") === "true";
      })()`);
      if (!pressed) return;
      await waitFor(
        () => session.eval(openFilterBtnProbe(btnTestId)),
        5_000,
        `${label} filter popover (clear)`,
      );
      if (!(await session.eval(FILTER_SELECT_ALL_PROBE)))
        fail(`${label} filter: could not select-all to clear`);
      if (!(await session.eval(FILTER_APPLY_PROBE)))
        fail(`${label} filter: Apply (clear) failed`);
    }
    await clearColumnIfActive("trace-filter-btn-name", "Name");
    await clearColumnIfActive("trace-filter-btn-protocol", "Protocol");
    const cleared = await waitFor(async () => {
      const s = await session.eval(FILTER_STATE_PROBE);
      return !s.chipPresent && !s.protoBtnPressed && !s.nameBtnPressed && !s.dirBtnPressed
        ? s
        : null;
    }, 10_000, "Filtered chip absent after clearing filters");
    console.log("filter cleared:", JSON.stringify({
      chipPresent: cleared.chipPresent,
      rowCount: cleared.rowCount,
    }));

    // v0.1.6 phases — each is isolated so a missing Rust command/fixture
    // reports its own FAIL without skipping the rest of the report.
    const v016 = {
      dependencies: false,
      diagnostics: false,
      pcapEof: false,
      timeToggle: false,
      live: false,
    };

    // Phase (a) — Settings › Dependencies (CP-008).
    try {
      await waitFor(
        () => session.eval(clickProbe("nav-settings")),
        10_000,
        "nav-settings clickable",
      );
      const deps = await waitFor(async () => {
        const s = await session.eval(DEPS_PROBE);
        return s.panelPresent && s.rows.every((r) => r.label) ? s : null;
      }, 15_000, "Dependencies panel with 4 status chips");
      if (!deps.allOk) {
        fail(
          `Dependencies statuses outside allowed set: ${JSON.stringify(deps.rows)}`,
        );
      } else if (deps.rows.length !== 4) {
        fail(`expected 4 dependency rows, got ${deps.rows.length}`);
      } else {
        v016.dependencies = true;
        console.log(
          "dependencies: PASS",
          JSON.stringify(deps.rows.map((r) => `${r.id}=${r.label}`)),
        );
      }
    } catch (err) {
      fail(`dependencies phase: ${err?.message ?? err}`);
      const snap = await session.eval(`(() => {
        const err = document.querySelector('[data-testid="settings-deps-error"]');
        const panel = document.querySelector('[data-testid="settings-dependencies-panel"]');
        return {
          panel: !!panel,
          error: err ? (err.textContent || "").trim() : null,
        };
      })()`).catch(() => null);
      if (snap) console.log("dependencies snapshot:", JSON.stringify(snap));
    }

    // Phase (b) — Settings › Diagnostics report (CP-008).
    try {
      const diag = await waitFor(async () => {
        const s = await session.eval(DIAG_PROBE);
        return s.report.length > 20 ? s : null;
      }, 15_000, "Diagnostics report text");
      if (!diag.hasRadeau) fail(`Diagnostics report missing "RadEAU": ${diag.report.slice(0, 200)}`);
      else if (!diag.hasLogPath)
        fail(`Diagnostics report / log line missing a log path: report=${diag.report.slice(0, 200)} log=${diag.logText}`);
      else {
        v016.diagnostics = true;
        console.log(
          "diagnostics: PASS",
          JSON.stringify({ logText: diag.logText.slice(0, 120) }),
        );
      }
    } catch (err) {
      fail(`diagnostics phase: ${err?.message ?? err}`);
    }

    // Phase (c) — pcap file source end-of-file (CP-005).
    let sessionTimeSample = null;
    try {
      if (!existsSync(PCAP_FIXTURE)) {
        fail(
          `pcap fixture missing at ${PCAP_FIXTURE} (expected once Rust side lands fixtures)`,
        );
      } else {
        const runState = await session.eval(APPBAR_RUN_LABEL_PROBE);
        if (runState && /stop/i.test(runState.label || "")) {
          if (!(await session.eval(clickProbe("appbar-run-btn"))))
            fail("could not Stop before pcap phase");
          await sleep(500);
        }

        await waitFor(
          () => session.eval(clickProbe("nav-settings")),
          10_000,
          "nav-settings for pcap",
        );
        if (!(await session.eval(OPEN_SETTINGS_SOURCE_SELECT_PROBE)))
          fail("could not open source select for pcap");
        await sleep(200);
        if (!(await session.eval(clickProbe("settings-source-option-pcap"))))
          fail("could not select pcap file source");
        await sleep(200);
        if (!(await session.eval(setTextFieldProbe("settings-pcap-path", PCAP_FIXTURE))))
          fail("could not set settings-pcap-path");
        if (!(await session.eval(clickProbe("settings-pcap-pace-fast"))))
          fail("could not click settings-pcap-pace-fast");

        await waitFor(
          () => session.eval(clickProbe("nav-trace")),
          10_000,
          "nav-trace before pcap start",
        );
        await session.eval(clickProbe("trace-clear-btn"));
        if (!(await session.eval(clickProbe("appbar-run-btn"))))
          fail("could not Start pcap session");

        const pcapLive = await waitFor(async () => {
          const s = await session.eval(TRACE_STATE_PROBE);
          return s.tablePresent && s.rowCount > 0 ? s : null;
        }, 15_000, "pcap rows to appear");
        console.log("pcap live:", JSON.stringify({ rowCount: pcapLive.rowCount }));
        sessionTimeSample = await session.eval(FIRST_TIME_CELL_PROBE);

        const ended = await waitFor(async () => {
          const s = await session.eval(APPBAR_RUN_LABEL_PROBE);
          if (!s) return null;
          const label = (s.label || "").toLowerCase();
          if (label.includes("start") || s.pressed === "false") return s;
          return null;
        }, 15_000, "app-bar Start after pcap EOF");
        console.log("pcap eof appbar:", JSON.stringify(ended));

        const after = await session.eval(TRACE_STATE_PROBE);
        if (after.rowCount <= 0)
          fail(`pcap rows disappeared after EOF: ${JSON.stringify(after)}`);

        await waitFor(
          () => session.eval(clickProbe("nav-network")),
          10_000,
          "nav-network after pcap EOF",
        );
        const netEof = await waitFor(async () => {
          const s = await session.eval(NETWORK_EOF_PROBE);
          return s.linkLabel && /closed/i.test(s.linkLabel) ? s : null;
        }, 10_000, "Network Closed after pcap EOF");
        if (!netEof.linkDetail || !/end of file/i.test(netEof.linkDetail)) {
          throw new Error(
            `Network closed detail missing end of file: ${JSON.stringify(netEof)}`,
          );
        }
        console.log("pcap network:", JSON.stringify(netEof));
        v016.pcapEof = true;

        // Phase (d) — Time toggle wall mode on the pcap session.
        await waitFor(
          () => session.eval(clickProbe("nav-trace")),
          10_000,
          "nav-trace for time toggle",
        );
        if (!(await session.eval(OPEN_DISPLAY_SETTINGS_PROBE)))
          throw new Error("could not open display-settings for time toggle");
        await sleep(200);
        const wallClicked = await session.eval(CLICK_WALL_TIME_PROBE);
        if (!wallClicked) {
          throw new Error(
            "wall time mode disabled or missing (source has no wall-clock anchor?)",
          );
        }
        const wallSample = await waitFor(async () => {
          const t = await session.eval(FIRST_TIME_CELL_PROBE);
          return t && /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(t) ? t : null;
        }, 5_000, "Time cell HH:MM:SS.mmm in wall mode");
        v016.timeToggle = true;
        console.log(
          "time toggle: PASS",
          JSON.stringify({ session: sessionTimeSample, wall: wallSample }),
        );
      }
    } catch (err) {
      fail(`pcap/time phase: ${err?.message ?? err}`);
    }

    // Phase (e) — live loopback via Npcap (CP-010..013). Isolated; skip honestly
    // when Npcap is missing or no loopback device is listed.
    try {
      const runState = await session.eval(APPBAR_RUN_LABEL_PROBE);
      if (runState && /stop/i.test(runState.label || "")) {
        if (!(await session.eval(clickProbe("appbar-run-btn"))))
          fail("could not Stop before live phase");
        await sleep(500);
      }

      await waitFor(
        () => session.eval(clickProbe("nav-settings")),
        10_000,
        "nav-settings for live",
      );
      await waitFor(async () => {
        const ok = await session.eval(
          `!!document.querySelector('[data-testid="settings-source-select"]')`,
        );
        return ok ? true : null;
      }, 10_000, "settings source select for live");

      if (!(await session.eval(OPEN_SETTINGS_SOURCE_SELECT_PROBE)))
        fail("could not open source select for live");
      await sleep(200);

      const liveOpt = await session.eval(LIVE_OPTION_STATE_PROBE);
      if (!liveOpt.present) {
        fail("settings-source-option-live missing");
      } else if (liveOpt.disabled) {
        console.log("live: SKIP (Npcap missing)");
        v016.live = "skipped";
        // Dismiss the open menu so later clicks are not blocked.
        await session.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true,
        }))`);
      } else {
        if (!(await session.eval(clickProbe("settings-source-option-live"))))
          fail("could not select Physical interface source");
        await sleep(300);

        // Refresh the interface list (also auto-loads on select).
        await waitFor(
          () => session.eval(clickProbe("settings-live-refresh")),
          10_000,
          "settings-live-refresh",
        );
        await sleep(500);

        const listErr = await session.eval(`(() => {
          const el = document.querySelector('[data-testid="settings-live-error"]');
          return el ? (el.textContent || "").trim() : null;
        })()`);
        if (listErr) {
          throw new Error(`listInterfaces rejected: ${listErr}`);
        }

        if (!(await session.eval(OPEN_SETTINGS_LIVE_INTERFACE_PROBE)))
          fail("could not open settings-live-interface");
        await sleep(200);

        const picked = await session.eval(CLICK_LIVE_LOOPBACK_OPTION_PROBE);
        if (!picked || !picked.ok) {
          console.log(
            "live: SKIP (no loopback interface)",
            JSON.stringify(picked),
          );
          v016.live = "skipped";
          await session.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape", bubbles: true,
          }))`);
        } else {
          console.log("live interface:", JSON.stringify(picked));

          await waitFor(
            () => session.eval(clickProbe("nav-trace")),
            10_000,
            "nav-trace before live start",
          );
          await session.eval(clickProbe("trace-clear-btn"));
          if (!(await session.eval(clickProbe("appbar-run-btn"))))
            fail("could not Start live session");

          const liveTrace = await waitFor(async () => {
            const s = await session.eval(LIVE_TRACE_PROBE);
            return s.rowCount > 0 && s.someipOrSd && s.source127 ? s : null;
          }, 20_000, "live Trace SOME/IP|SD rows with Source 127.0.0.1");
          console.log("live trace:", JSON.stringify(liveTrace));

          await waitFor(
            () => session.eval(clickProbe("nav-network")),
            10_000,
            "nav-network during live",
          );
          const liveNet = await waitFor(async () => {
            const n = await session.eval(NETWORK_CONNECTION_PROBE);
            return n.panelPresent &&
              n.sourceKind === "Physical interface" &&
              n.sessionLabel &&
              /running/i.test(n.sessionLabel)
              ? n
              : null;
          }, 10_000, "Network Connection Physical interface running");
          console.log("live network:", JSON.stringify(liveNet));

          if (!(await session.eval(clickProbe("appbar-run-btn"))))
            fail("could not Stop live session");
          await sleep(300);
          v016.live = true;
          console.log("live: PASS");
        }
      }
    } catch (err) {
      fail(`live phase: ${err?.message ?? err}`);
      v016.live = false;
    }

    console.log(
      `PASS — devgen ${trace.rowCount} rows (Fixed→Sequential); simulator link ${sim.rowCount} rows, ` +
        `degraded chip absent, protocols [${[...protocolsRendered].join(", ")}], ` +
        `LidarClusters + Dir Rx + VLAN 802.1Q; Network Connection "${network.sourceKind}" / "${network.linkLabel}" ` +
        `received=${network.receivedN}; catalog names + clean dissections + decoded signals; ` +
        `filters Protocol/Dir/Name; v0.1.6=${JSON.stringify(v016)}`,
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
