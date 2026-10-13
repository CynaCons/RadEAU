/**
 * Frontend perf harness (PF-005) — launches the real RadEAU debug binary against the
 * vite dev server, drives the dev generator at the stress profile
 * (5,000 frames/s), and measures what the UI does with that load, per
 * scenario:
 *
 *   - React commits + actual render ms per zone (top bar, nav rail, each view)
 *     and per-row renders in the Trace table (src/runtime/perfProbe.tsx);
 *   - style recalcs, layouts, paints and their durations (CDP Performance;
 *     verification evidence for TR-015, TR-016, TR-017, and VU-019)
 *     metrics + a devtools.timeline trace);
 *   - long tasks and event-loop lag;
 *   - frames delivered to the UI per second.
 *
 * The ring is filled to its 200,000-row cap before the measured scenarios so
 * every number is steady state, not the cheap empty-ring start.
 *
 *   npm run test:perf                       measure, print, write perf/last-run.json
 *   npm run test:perf -- --write-baseline   also commit the numbers as perf/baseline.json
 *   npm run test:perf -- --check            fail when a budget in perf/budgets.json is exceeded
 *   npm run test:perf -- --profile          also print the hottest JS functions (Trace, steady state)
 *   RADEAU_PERF_FILL_S=10 / RADEAU_PERF_MEASURE_S=4   shorter local runs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  waitFor,
} from "./e2e-lib.mjs";

const EXE = join(repoRoot, "target", "debug", "radeau.exe");
const CDP_PORT = 9300 + Math.floor(Math.random() * 4000);
const FILL_S = Number(process.env.RADEAU_PERF_FILL_S ?? 45);
const WARMUP_S = 2;
const MEASURE_S = Number(process.env.RADEAU_PERF_MEASURE_S ?? 8);
const PERF_DIR = join(repoRoot, "perf");
const args = new Set(process.argv.slice(2));

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
  if (existsSync(EXE)) return;
  console.log("debug binary missing — building…");
  await new Promise((resolve, reject) => {
    const child = spawnHidden("cargo build -p radeau", { cwd: repoRoot });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cargo build exited ${code}`))));
  });
}

// Installed once: long-task observer + 50 ms event-loop lag sampler.
const PAGE_PROBES = `(() => {
  if (window.__radeauPerfPage) return true;
  const page = { longTasks: 0, longTaskMs: 0, lagMax: 0, lagOver50: 0, last: performance.now() };
  window.__radeauPerfPage = page;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { page.longTasks += 1; page.longTaskMs += e.duration; }
  }).observe({ type: "longtask" });
  setInterval(() => {
    const now = performance.now();
    const drift = now - page.last - 50;
    page.last = now;
    if (drift > page.lagMax) page.lagMax = drift;
    if (drift > 50) page.lagOver50 += 1;
  }, 50);
  return true;
})()`;

const RESET_PROBE = `(() => {
  window.__radeauPerf.reset();
  const p = window.__radeauPerfPage;
  p.longTasks = 0; p.longTaskMs = 0; p.lagMax = 0; p.lagOver50 = 0;
  const s = window.__radeauSession.getSnapshot().stats;
  return { emitted: s ? s.emitted : 0, t: performance.now() };
})()`;

const READ_PROBE = `(() => {
  const s = window.__radeauSession.getSnapshot().stats;
  const p = window.__radeauPerfPage;
  return {
    zones: window.__radeauPerf.zones,
    counters: window.__radeauPerf.counters,
    longTasks: p.longTasks, longTaskMs: p.longTaskMs, lagMax: p.lagMax, lagOver50: p.lagOver50,
    emitted: s ? s.emitted : 0, t: performance.now(),
  };
})()`;

const METRIC_KEYS = [
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "ScriptDuration",
  "TaskDuration",
];

async function metrics(session) {
  const { metrics: list } = await session.send("Performance.getMetrics");
  const out = {};
  for (const m of list) if (METRIC_KEYS.includes(m.name)) out[m.name] = m.value;
  return out;
}

/** Counts timeline events over the measure window (paint + layout pipeline). */
async function traceTimeline(session, seconds) {
  const counts = { Paint: 0, PaintMs: 0, Layout: 0, UpdateLayoutTree: 0, Commit: 0 };
  const off = session.on("Tracing.dataCollected", ({ value }) => {
    for (const e of value) {
      if (e.ph !== "X" && e.ph !== "B") continue;
      if (e.name === "Paint") {
        counts.Paint += 1;
        counts.PaintMs += (e.dur ?? 0) / 1000;
      } else if (e.name in counts) counts[e.name] += 1;
    }
  });
  const done = new Promise((resolve) => {
    const offDone = session.on("Tracing.tracingComplete", () => {
      offDone();
      resolve();
    });
  });
  await session.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  await sleep(seconds * 1000);
  await session.send("Tracing.end");
  await done;
  off();
  return counts;
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

async function measure(session, name) {
  await sleep(WARMUP_S * 1000);
  const before = await session.eval(RESET_PROBE);
  const m0 = await metrics(session);
  const timeline = await traceTimeline(session, MEASURE_S);
  const m1 = await metrics(session);
  const after = await session.eval(READ_PROBE);
  const secs = (after.t - before.t) / 1000;
  const perS = (v) => round(v / secs);
  const zones = {};
  for (const [id, z] of Object.entries(after.zones)) {
    zones[id] = { commitsPerS: perS(z.commits), renderMsPerS: perS(z.actualMs) };
  }
  const result = {
    scenario: name,
    seconds: round(secs),
    framesPerS: perS(after.emitted - before.emitted),
    zones,
    traceRowRendersPerS: perS(after.counters["trace-row"] ?? 0),
    recalcStylePerS: perS(m1.RecalcStyleCount - m0.RecalcStyleCount),
    layoutPerS: perS(m1.LayoutCount - m0.LayoutCount),
    paintPerS: perS(timeline.Paint),
    paintMsPerS: perS(timeline.PaintMs),
    styleMsPerS: perS((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
    layoutMsPerS: perS((m1.LayoutDuration - m0.LayoutDuration) * 1000),
    scriptMsPerS: perS((m1.ScriptDuration - m0.ScriptDuration) * 1000),
    taskMsPerS: perS((m1.TaskDuration - m0.TaskDuration) * 1000),
    longTasks: after.longTasks,
    longTaskMs: round(after.longTaskMs),
    lagMaxMs: round(after.lagMax),
  };
  printScenario(result);
  return result;
}

function printScenario(r) {
  const zones = Object.entries(r.zones)
    .filter(([, z]) => z.commitsPerS > 0)
    .map(([id, z]) => `${id} ${z.commitsPerS}/s ${z.renderMsPerS}ms/s`)
    .join(" · ");
  console.log(
    `\n[${r.scenario}] ${r.framesPerS} frames/s over ${r.seconds}s\n` +
      `  commits: ${zones || "none"}\n` +
      `  trace rows rendered: ${r.traceRowRendersPerS}/s\n` +
      `  style ${r.recalcStylePerS}/s (${r.styleMsPerS} ms/s) · layout ${r.layoutPerS}/s (${r.layoutMsPerS} ms/s) · ` +
      `paint ${r.paintPerS}/s (${r.paintMsPerS} ms/s)\n` +
      `  script ${r.scriptMsPerS} ms/s · task ${r.taskMsPerS} ms/s · long tasks ${r.longTasks} (${r.longTaskMs} ms) · lag max ${r.lagMaxMs} ms`,
  );
}

/** Samples the JS profiler for `seconds` and prints the top self-time frames. */
async function profileTop(session, seconds) {
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 200 });
  await session.send("Profiler.start");
  await sleep(seconds * 1000);
  const { profile } = await session.send("Profiler.stop");
  const self = new Map();
  for (const node of profile.nodes) {
    const cf = node.callFrame;
    const file = (cf.url || "").split("?")[0].split("/").slice(-2).join("/");
    const key = `${cf.functionName || "(anonymous)"} ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (node.hitCount || 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([k, v]) => `${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
  console.log(`\nprofile (${seconds}s, ${total} samples):\n${top.join("\n")}`);
}

async function nav(session, view) {
  if (!(await session.eval(clickProbe(`nav-${view}`)))) throw new Error(`nav-${view} not clickable`);
  await sleep(300);
}

async function setTraceMode(session, mode) {
  await waitFor(() => session.eval(clickProbe("trace-display-settings-btn")), 5_000, "display settings");
  await sleep(200);
  const ok = await session.eval(`(() => {
    const radio = document.querySelector('[data-testid="trace-mode-${mode}"]');
    if (!radio) return false;
    const input = radio.matches("input") ? radio : radio.querySelector("input");
    (input || radio).click();
    return true;
  })()`);
  if (!ok) throw new Error(`trace-mode-${mode} missing`);
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await sleep(300);
}

/** Budgets: { scenario: { metric: max } } with zone metrics as "zone:<id>:commitsPerS". */
function checkBudgets(results) {
  const path = join(PERF_DIR, "budgets.json");
  if (!existsSync(path)) throw new Error("perf/budgets.json missing");
  const budgets = JSON.parse(readFileSync(path, "utf8"));
  const failures = [];
  for (const [scenario, limits] of Object.entries(budgets)) {
    const r = results.find((x) => x.scenario === scenario);
    if (!r) {
      failures.push(`${scenario}: scenario not measured`);
      continue;
    }
    for (const [metric, max] of Object.entries(limits)) {
      let value;
      if (metric.startsWith("zone:")) {
        const [, id, field] = metric.split(":");
        value = r.zones[id]?.[field] ?? 0;
      } else if (metric.startsWith("min:")) {
        value = r[metric.slice(4)];
        if (value < max) failures.push(`${scenario}: ${metric.slice(4)} ${value} < ${max}`);
        continue;
      } else value = r[metric];
      if (value > max) failures.push(`${scenario}: ${metric} ${value} > ${max}`);
    }
  }
  return failures;
}

async function main() {
  const viteProc = await ensureVite();
  await ensureBinary();
  const userDataDir = mkdtempSync(join(tmpdir(), "radeau-perf-"));
  const appProc = launchApp(EXE, CDP_PORT, userDataDir);
  let session = null;
  let exitCode = 0;
  try {
    const page = await cdpPageTarget(CDP_PORT, 45_000);
    session = new CdpSession(page.webSocketDebuggerUrl);
    await session.open();
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await session.send("Performance.enable");
    await waitFor(
      () => session.eval(`!!(window.__radeauPerf && window.__radeauSession)`),
      30_000,
      "dev perf hooks (is this the vite dev build?)",
    );
    await session.eval(PAGE_PROBES);
    await nav(session, "trace");

    const results = [];
    results.push(await measure(session, "idle-stopped"));

    // Stress source, then fill the ring to its cap (steady state).
    await session.eval(`(() => {
      const s = window.__radeauSession;
      s.setSourceKind("devgen");
      s.setDevgenProfile("stress");
      return true;
    })()`);
    if (!(await session.eval(clickProbe("appbar-run-btn")))) throw new Error("appbar-run-btn missing");
    await waitFor(() => session.eval(`window.__radeauSession.getSnapshot().running`), 10_000, "capture running");
    console.log(`filling the ring for ${FILL_S}s at the stress profile…`);
    await sleep(FILL_S * 1000);
    if (args.has("--profile")) await profileTop(session, 6);

    results.push(await measure(session, "trace-fixed"));
    await setTraceMode(session, "sequential");
    results.push(await measure(session, "trace-sequential"));
    await setTraceMode(session, "fixed");
    await nav(session, "network");
    results.push(await measure(session, "network-visible"));
    await nav(session, "recorder");
    results.push(await measure(session, "recorder-visible"));
    await nav(session, "settings");
    results.push(await measure(session, "settings-visible"));
    await nav(session, "trace");

    if (!(await session.eval(clickProbe("appbar-run-btn")))) throw new Error("could not stop");
    await waitFor(() => session.eval(`!window.__radeauSession.getSnapshot().running`), 10_000, "capture stopped");
    results.push(await measure(session, "idle-after-stop"));

    mkdirSync(PERF_DIR, { recursive: true });
    const record = {
      generatedAt: new Date().toISOString(),
      build: "debug binary + vite dev (React development build)",
      load: "devgen stress profile, ring filled to cap",
      fillSeconds: FILL_S,
      measureSeconds: MEASURE_S,
      results,
    };
    writeFileSync(join(PERF_DIR, "last-run.json"), `${JSON.stringify(record, null, 2)}\n`);
    if (args.has("--write-baseline")) {
      writeFileSync(join(PERF_DIR, "baseline.json"), `${JSON.stringify(record, null, 2)}\n`);
      console.log("\nwrote perf/baseline.json");
    }
    if (args.has("--check")) {
      const failures = checkBudgets(results);
      if (failures.length) {
        for (const f of failures) console.error(`FAIL ${f}`);
        exitCode = 1;
      } else console.log("\nPASS — every perf budget held");
    }
  } catch (err) {
    console.error(`FAIL ${err?.message ?? err}`);
    exitCode = 1;
  } finally {
    session?.close();
    killTree(appProc.pid);
    if (viteProc) killTree(viteProc.pid);
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* WebView2 may still hold the profile briefly */
    }
  }
  process.exit(exitCode);
}

main();
