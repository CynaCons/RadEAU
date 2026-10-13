/**
 * Visual check: launches the debug app against the simulator and writes PNG
 * screenshots of the views changed by an iteration (look at it before "done").
 *
 *   node scripts/capture-views.mjs <out-dir>
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CdpSession,
  VITE_URL,
  cdpPageTarget,
  clickProbe,
  killTree,
  launchApp,
  reachable,
  repoRoot,
  sleep,
  spawnHidden,
  tcpReachable,
  waitFor,
} from "./e2e-lib.mjs";

const outDir = process.argv[2] ?? join(repoRoot, "target", "captures");
const EXE = join(repoRoot, "target", "debug", "radeau.exe");
const NETSIM = join(repoRoot, "target", "debug", "ecu-netsim.exe");
const FIXTURE = join(repoRoot, "fixtures", "pcap", "sensor-fusion-5s.pcap");
const CDP_PORT = 9300 + Math.floor(Math.random() * 4000);
const SIM_PORT = 15560 + Math.floor(Math.random() * 2000);

async function shot(session, name) {
  const { data } = await session.send("Page.captureScreenshot", { format: "png" });
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(path);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const vite = (await reachable(VITE_URL, 1000)) ? null : spawnHidden("npm run dev", { cwd: repoRoot });
  if (vite && !(await reachable(VITE_URL, 30_000))) throw new Error("vite did not start");
  const netsim = spawnHidden(`"${NETSIM}" --monitor-port ${SIM_PORT} --seed 7`, { cwd: repoRoot });
  await tcpReachable(SIM_PORT, 15_000);
  const profile = mkdtempSync(join(tmpdir(), "radeau-capture-"));
  const app = launchApp(EXE, CDP_PORT, profile);
  try {
    const page = await cdpPageTarget(CDP_PORT, 45_000);
    const session = new CdpSession(page.webSocketDebuggerUrl);
    await session.open();
    await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => session.eval(`!!window.__radeauSession`), 30_000, "app");
    await session.eval(`(() => { const s = window.__radeauSession; s.setSourceKind("sim"); s.setSimAddr("127.0.0.1:${SIM_PORT}"); return true; })()`);
    await session.eval(clickProbe("appbar-run-btn"));
    await sleep(4_000);
    await session.eval(clickProbe("nav-network"));
    await waitFor(() => session.eval(clickProbe("network-analyze-btn")), 5_000, "analyze");
    await sleep(1_500);
    await shot(session, "network-analysis");
    await session.eval(clickProbe("appbar-run-btn"));
    await sleep(500);
    const path = FIXTURE.replaceAll("\\", "\\\\");
    await session.eval(`window.__radeauReplay.open("${path}")`);
    await session.eval(clickProbe("nav-trace"));
    await session.eval(clickProbe("replay-play-btn"));
    await sleep(1_500);
    await session.eval(`window.__radeauReplay.pause()`);
    await sleep(500);
    await shot(session, "trace-replay");
    session.close();
  } finally {
    killTree(app.pid);
    killTree(netsim.pid);
    if (vite) killTree(vite.pid);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
