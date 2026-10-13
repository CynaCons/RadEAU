/**
 * Dev-only render accounting for the perf harness (`npm run test:perf`).
 * `PerfZone` wraps a subtree in a React Profiler and `countRender` tallies
 * per-item renders (trace rows); both read back at `window.__radeauPerf`.
 * Production builds compile to a pass-through: no Profiler, no counters.
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

export interface ZoneStats {
  commits: number;
  actualMs: number;
}

interface PerfRegistry {
  zones: Record<string, ZoneStats>;
  counters: Record<string, number>;
  reset: () => void;
}

const PERF_ENABLED = import.meta.env.DEV;

const registry: PerfRegistry = {
  zones: {},
  counters: {},
  reset() {
    registry.zones = {};
    registry.counters = {};
  },
};

if (PERF_ENABLED) {
  (globalThis as { __radeauPerf?: PerfRegistry }).__radeauPerf = registry;
}

const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  const zone = registry.zones[id] ?? (registry.zones[id] = { commits: 0, actualMs: 0 });
  zone.commits += 1;
  zone.actualMs += actualDuration;
};

export function PerfZone(props: { id: string; children: ReactNode }): ReactNode {
  if (!PERF_ENABLED) return props.children;
  return (
    <Profiler id={props.id} onRender={onRender}>
      {props.children}
    </Profiler>
  );
}

export function countRender(name: string): void {
  if (!PERF_ENABLED) return;
  registry.counters[name] = (registry.counters[name] ?? 0) + 1;
}
