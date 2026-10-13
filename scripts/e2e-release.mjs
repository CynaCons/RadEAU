/**
 * Release portable e2e — launches the zip's radeau.exe (embedded UI, no vite),
 * asserts release-shaped Settings/About, and replays the bundled pcap fixture.
 *
 * Assumes `npm run build:portable` has already produced
 * dist-portable/RadEAU-<version>-win64/.
 *
 * Run: npm run test:e2e:release
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  APPBAR_RUN_LABEL_PROBE,
  CdpSession,
  DEPS_PROBE,
  NETWORK_EOF_PROBE,
  OPEN_SETTINGS_SOURCE_SELECT_PROBE,
  SHELL_PROBE,
  TRACE_STATE_PROBE,
  VITE_URL,
  cdpPageTarget,
  clickProbe,
  killTree,
  launchApp,
  portableDir,
  portClosed,
  reachable,
  readTauriVersion,
  setTextFieldProbe,
  sleep,
  waitFor,
} from "./e2e-lib.mjs";

const CDP_PORT = 9300 + Math.floor(Math.random() * 4000);

const ABOUT_PROBE = `(() => {
  const version = document.querySelector('[data-testid="about-version"]');
  const build = document.querySelector('[data-testid="about-build"]');
  const os = document.querySelector('[data-testid="about-os"]');
  return {
    dialog: !!document.querySelector('[data-testid="about-dialog"]'),
    version: version ? (version.textContent || "").trim() : null,
    build: build ? (build.textContent || "").trim() : null,
    os: os ? (os.textContent || "").trim() : null,
  };
})()`;

const SOURCE_OPTIONS_PROBE = `(() => {
  const options = [...document.querySelectorAll('[data-testid^="settings-source-option-"]')];
  return {
    ids: options.map((o) => o.getAttribute("data-testid")),
    hasDevgen: !!document.querySelector('[data-testid="settings-source-option-devgen"]'),
  };
})()`;

const DOIP_ROW_PROBE = `(() => {
  const table = document.querySelector('[data-testid="trace-table"]');
  if (!table) return { rowCount: 0, hasDoip: false };
  const rows = [...table.querySelectorAll("tbody tr")].filter(
    (r) => !(r.getAttribute("data-testid") || "").startsWith("trace-detail-row"),
  );
  let hasDoip = false;
  for (const row of rows) {
    const cells = [...row.querySelectorAll("td")].map((c) => (c.textContent || "").trim());
    if (cells.some((t) => t === "DoIP")) hasDoip = true;
  }
  const totalAttr = table.getAttribute("data-row-total");
  return {
    rowCount: totalAttr != null ? Number(totalAttr) : rows.length,
    hasDoip,
  };
})()`;

async function main() {
  const version = readTauriVersion();
  const dir = portableDir(version);
  const exe = join(dir, "radeau.exe");
  const pcapFixture = join(dir, "sensor-fusion-5s.pcap");

  if (!existsSync(exe)) {
    throw new Error(
      `portable exe missing at ${exe} — run npm run build:portable first`,
    );
  }
  if (!existsSync(pcapFixture)) {
    throw new Error(`portable pcap fixture missing at ${pcapFixture}`);
  }

  // AU-010: the MCP bridge ships in the bundle and answers MCP initialize.
  const mcpExe = join(dir, "radeau-mcp.exe");
  if (!existsSync(mcpExe)) throw new Error(`radeau-mcp.exe missing from the bundle at ${mcpExe}`);
  const init = spawnSync(mcpExe, [], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-e2e", version: "1" } } })}\n`,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const initLine = (init.stdout || "").split("\n").find((l) => l.trim());
  if (!initLine || JSON.parse(initLine).result?.serverInfo?.name !== "radeau-mcp")
    throw new Error(`radeau-mcp initialize failed: ${init.stdout} ${init.stderr}`);
  console.log("radeau-mcp in bundle: initialize OK");

  // Release exe embeds dist — vite must not be required (and should stay down).
  if (await reachable(VITE_URL, 800)) {
    throw new Error(
      "localhost:1420 is already serving; stop the vite dev server before test:e2e:release",
    );
  }
  if (!(await portClosed(1420))) {
    throw new Error("port 1420 is accepting connections; release e2e requires it closed");
  }

  const userDataDir = mkdtempSync(join(tmpdir(), "radeau-e2e-release-"));
  const appProc = launchApp(exe, CDP_PORT, userDataDir, dir);
  let session = null;
  let failures = 0;

  const fail = (msg) => {
    failures += 1;
    console.error(`FAIL ${msg}`);
  };

  try {
    const page = await cdpPageTarget(CDP_PORT, 60_000);
    session = new CdpSession(page.webSocketDebuggerUrl);
    await session.open();

    // Confirm still no vite while the app is up (embedded UI).
    if (await reachable(VITE_URL, 800)) {
      fail("vite appeared on :1420 during release run (exe must not need it)");
    }

    const shell = await waitFor(async () => {
      const s = await session.eval(SHELL_PROBE);
      return s.appBarVisible && s.navRailVisible ? s : null;
    }, 45_000, "app shell to mount");
    console.log("shell:", JSON.stringify(shell));
    if (shell.title !== "RadEAU") fail(`title is "${shell.title}", expected RadEAU`);

    // About — buildProfile release.
    if (!(await session.eval(clickProbe("nav-about")))) fail("could not open About");
    const about = await waitFor(async () => {
      const a = await session.eval(ABOUT_PROBE);
      return a.dialog && a.build ? a : null;
    }, 10_000, "About dialog");
    console.log("about:", JSON.stringify(about));
    if (about.build !== "release") fail(`About buildProfile is "${about.build}", expected release`);
    if (!about.version) fail("About version empty");
    // Dismiss About (Escape).
    await session.eval(`(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    })()`);
    await sleep(300);

    // Settings — no Dev generator; Dependencies has 4 rows.
    await waitFor(
      () => session.eval(clickProbe("nav-settings")),
      10_000,
      "nav-settings",
    );
    await waitFor(async () => {
      const ok = await session.eval(
        `!!document.querySelector('[data-testid="settings-source-select"]')`,
      );
      return ok ? true : null;
    }, 10_000, "settings source select");

    if (!(await session.eval(OPEN_SETTINGS_SOURCE_SELECT_PROBE))) {
      fail("could not open Settings source select");
    } else {
      await sleep(200);
      const opts = await session.eval(SOURCE_OPTIONS_PROBE);
      console.log("source options:", JSON.stringify(opts));
      if (opts.hasDevgen) fail("Dev generator option still present in release build");
      // Close the menu.
      await session.eval(`(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return true;
      })()`);
      await sleep(200);
    }

    const deps = await waitFor(async () => {
      const d = await session.eval(DEPS_PROBE);
      return d.panelPresent && d.rows.length === 4 ? d : null;
    }, 10_000, "Dependencies panel with 4 rows");
    if (!deps.allOk) fail(`Dependencies rows incomplete: ${JSON.stringify(deps.rows)}`);
    console.log("deps:", JSON.stringify(deps.rows.map((r) => ({ id: r.id, head: r.head }))));

    // pcap replay of the fixture from the zip folder (same probes as smoke pcap phase).
    if (!(await session.eval(OPEN_SETTINGS_SOURCE_SELECT_PROBE))) {
      fail("could not re-open source select for pcap");
    } else {
      await sleep(200);
      if (!(await session.eval(clickProbe("settings-source-option-pcap")))) {
        fail("could not select pcap file source");
      } else {
        await sleep(200);
        if (!(await session.eval(setTextFieldProbe("settings-pcap-path", pcapFixture)))) {
          fail("could not set settings-pcap-path");
        }
        if (!(await session.eval(clickProbe("settings-pcap-pace-fast")))) {
          fail("could not click settings-pcap-pace-fast");
        }
      }
    }

    await waitFor(
      () => session.eval(clickProbe("nav-trace")),
      10_000,
      "nav-trace before pcap start",
    );
    await session.eval(clickProbe("trace-clear-btn"));
    if (!(await session.eval(clickProbe("appbar-run-btn")))) {
      fail("could not Start pcap session");
    }

    const pcapLive = await waitFor(async () => {
      const s = await session.eval(TRACE_STATE_PROBE);
      return s.tablePresent && s.rowCount > 0 ? s : null;
    }, 20_000, "pcap rows to appear");
    console.log("pcap live:", JSON.stringify({ rowCount: pcapLive.rowCount }));

    // DoIP row in that replay (fixture includes DoIP).
    const doip = await waitFor(async () => {
      const s = await session.eval(DOIP_ROW_PROBE);
      return s.hasDoip ? s : null;
    }, 20_000, "DoIP row in pcap replay").catch((err) => {
      fail(`DoIP row missing: ${err.message}`);
      return null;
    });
    if (doip) console.log("doip:", JSON.stringify(doip));

    const ended = await waitFor(async () => {
      const s = await session.eval(APPBAR_RUN_LABEL_PROBE);
      if (!s) return null;
      const label = (s.label || "").toLowerCase();
      if (label.includes("start") || s.pressed === "false") return s;
      return null;
    }, 20_000, "app-bar Start after pcap EOF");
    console.log("pcap eof appbar:", JSON.stringify(ended));

    const after = await session.eval(TRACE_STATE_PROBE);
    if (after.rowCount <= 0) {
      fail(`pcap rows disappeared after EOF: ${JSON.stringify(after)}`);
    }

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
      fail(`Network closed detail missing end of file: ${JSON.stringify(netEof)}`);
    } else {
      console.log("pcap network:", JSON.stringify(netEof));
    }

    // Final check: still no vite.
    if (await reachable(VITE_URL, 500)) {
      fail("vite was serving on :1420 at end of release run");
    }

    if (failures === 0) {
      console.log(`PASS release e2e RadEAU ${version}`);
    } else {
      console.error(`FAIL release e2e with ${failures} failure(s)`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    session?.close();
    if (appProc?.pid) killTree(appProc.pid);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
