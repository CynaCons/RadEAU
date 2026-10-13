import { describe, expect, it } from "vitest";

import type { TraceFrame } from "./frameModel";
import {
  collapseFixed,
  IncrementalTraceProjection,
  displayRowsToArray,
  fixedDisplayKey,
  projectDisplayRows,
  windowSequential,
} from "./traceDisplay";
import { EMPTY_FILTER, type TraceFilter } from "./traceFilter";
import type { TraceRows } from "./traceStore";

function row(
  partial: Partial<TraceFrame> & Pick<TraceFrame, "id" | "protocol" | "source" | "key">,
): TraceFrame {
  return {
    tS: 0,
    time: "0.0000",
    dir: "rx",
    sourceTitle: partial.source,
    serviceMethod: "0x1101:0x8001",
    name: "CameraObjects.ObjectList",
    type: "Notification",
    session: "--",
    length: "100",
    payload: "DE AD",
    deltaGlobal: "--",
    deltaKey: "--",
    channel: "1",
    proto: 0,
    sv: 0x1101,
    m: 0x8001,
    srcEp: 0,
    ty: 0,
    se: -1,
    sa: 0,
    da: 0,
    sm: 0,
    vl: -1,
    ...partial,
  };
}

describe("fixedDisplayKey", () => {
  it("returns the precomputed row.key", () => {
    expect(
      fixedDisplayKey(
        row({
          id: 1,
          protocol: "SOME/IP",
          source: "10.42.0.11",
          serviceMethod: "0x1101:0x8001",
          key: "0:4353:32769",
        }),
      ),
    ).toBe("0:4353:32769");
  });

  it("passes through SD / gPTP keys unchanged", () => {
    expect(
      fixedDisplayKey(
        row({ id: 2, protocol: "SD", source: "camera", key: "1:168820747", serviceMethod: "0xFFFF:0x8100" }),
      ),
    ).toBe("1:168820747");
    expect(
      fixedDisplayKey(row({ id: 3, protocol: "gPTP", source: "radar", key: "2:123:0", serviceMethod: "--" })),
    ).toBe("2:123:0");
  });
});

describe("collapseFixed", () => {
  it("collapses to one row per key, last write wins", () => {
    const rows = [
      row({
        id: 1,
        time: "1.0000",
        protocol: "SOME/IP",
        source: "a",
        serviceMethod: "0x1101:0x8001",
        key: "0:4353:32769",
        deltaKey: "--",
      }),
      row({
        id: 2,
        time: "1.1000",
        protocol: "SOME/IP",
        source: "a",
        serviceMethod: "0x1101:0x8001",
        key: "0:4353:32769",
        deltaKey: "0.1000",
      }),
      row({
        id: 3,
        time: "1.2000",
        protocol: "SOME/IP",
        source: "b",
        serviceMethod: "0x1102:0x8001",
        key: "0:4354:32769",
        deltaKey: "--",
      }),
      row({ id: 4, time: "1.3000", protocol: "SD", source: "camera", key: "1:1", deltaKey: "--" }),
      row({ id: 5, time: "1.4000", protocol: "SD", source: "radar", key: "1:2", deltaKey: "--" }),
      row({ id: 6, time: "1.5000", protocol: "SD", source: "camera", key: "1:1", deltaKey: "0.2000" }),
      row({ id: 7, time: "1.6000", protocol: "gPTP", source: "fusion", key: "2:3:0", deltaKey: "--" }),
    ];
    const collapsed = collapseFixed(rows, new Set());
    expect(collapsed.map((r) => r.id).sort((a, b) => a - b)).toEqual([2, 3, 5, 6, 7]);
    const sdCamera = collapsed.find((r) => r.protocol === "SD" && r.source === "camera");
    expect(sdCamera?.deltaKey).toBe("0.2000");
    expect(sdCamera?.id).toBe(6);
  });

  it("orders pinned rows first, then key ascending", () => {
    const rows = [
      row({ id: 1, protocol: "SOME/IP", source: "a", serviceMethod: "0x1102:0x8001", key: "0:4354:32769" }),
      row({ id: 2, protocol: "SOME/IP", source: "a", serviceMethod: "0x1101:0x8001", key: "0:4353:32769" }),
      row({ id: 3, protocol: "gPTP", source: "zulu", key: "2:9:0" }),
      row({ id: 4, protocol: "SD", source: "alpha", key: "1:1" }),
    ];
    const pinned = new Set(["2:9:0", "0:4354:32769"]);
    const collapsed = collapseFixed(rows, pinned);
    expect(collapsed.map(fixedDisplayKey)).toEqual([
      "0:4354:32769",
      "2:9:0",
      "0:4353:32769",
      "1:1",
    ]);
  });

  it("rebuilds from the buffered ring on mode switch (no clear)", () => {
    const ring = [
      row({ id: 1, protocol: "SOME/IP", source: "a", serviceMethod: "0x1101:0x8001", key: "0:4353:32769", time: "0.1000" }),
      row({
        id: 2,
        protocol: "SOME/IP",
        source: "a",
        serviceMethod: "0x1101:0x8001",
        key: "0:4353:32769",
        time: "0.2000",
        deltaKey: "0.1000",
      }),
      row({ id: 3, protocol: "SD", source: "cam", key: "1:1", time: "0.2500" }),
    ];
    expect(projectDisplayRows(ring, "sequential", new Set(), 200_000)).toHaveLength(3);
    const fixed = projectDisplayRows(ring, "fixed", new Set(), 200_000);
    expect(fixed).toHaveLength(2);
    // Key ascending: "0:…" < "1:…"
    expect(fixed.map((r) => r.id)).toEqual([2, 3]);
    expect(fixed[0]!.deltaKey).toBe("0.1000");
  });
});

describe("windowSequential", () => {
  it("returns the last N rows", () => {
    const rows = [1, 2, 3, 4, 5].map((id) =>
      row({ id, protocol: "SOME/IP", source: "a", serviceMethod: "0x1101:0x8001", key: "0:4353:32769" }),
    );
    expect(windowSequential(rows, 3).map((r) => r.id)).toEqual([3, 4, 5]);
    expect(windowSequential(rows, 10)).toBe(rows);
  });
});

describe("IncrementalTraceProjection", () => {
  function ringRows(all: readonly TraceFrame[], capacity: number, epoch = 0): TraceRows {
    const visible = all.slice(-capacity);
    return {
      length: visible.length,
      epoch,
      startSequence: all.length - visible.length,
      endSequence: all.length,
      get: (index) => visible[index]!,
    };
  }

  it("equals full Fixed collapse across randomized appends and evictions", () => {
    const projection = new IncrementalTraceProjection();
    const all: TraceFrame[] = [];
    let seed = 0x51f15e;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let step = 0; step < 80; step += 1) {
      const batch = 1 + (random() % 7);
      for (let i = 0; i < batch; i += 1) {
        const id = all.length + 1;
        const key = `k:${random() % 13}`;
        all.push(row({ id, protocol: "SOME/IP", source: "a", key }));
      }
      const rows = ringRows(all, 37);
      const pinned = new Set([`k:${random() % 13}`, `k:${random() % 13}`]);
      expect(displayRowsToArray(projection.project(rows, "fixed", pinned, 20)).map((r) => r.id)).toEqual(
        collapseFixed(all.slice(-37), pinned).map((r) => r.id),
      );
    }
  });

  it("equals full filtered projections and rebuilds when the filter changes", () => {
    const projection = new IncrementalTraceProjection();
    const all: TraceFrame[] = [];
    const rx: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["rx"]) };
    const tx: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["tx"]) };
    for (let id = 1; id <= 75; id += 1) {
      all.push(row({
        id,
        protocol: "SOME/IP",
        source: "a",
        key: `k:${id % 9}`,
        dir: id % 3 === 0 ? "tx" : "rx",
      }));
      if (id % 5 !== 0) continue;
      const rows = ringRows(all, 31);
      for (const filter of [rx, tx]) {
        for (const mode of ["fixed", "sequential"] as const) {
          expect(displayRowsToArray(projection.project(rows, mode, new Set(), 11, filter)).map((r) => r.id)).toEqual(
            projectDisplayRows(all.slice(-31), mode, new Set(), 11, filter).map((r) => r.id),
          );
        }
      }
    }
  });

  it("keeps filtered state bounded by the ring over a long session (TR-014)", () => {
    const projection = new IncrementalTraceProjection();
    const rx: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["rx"]) };
    const capacity = 1_000;
    const window: TraceFrame[] = [];
    let total = 0;
    for (let step = 0; step < 200; step += 1) {
      for (let i = 0; i < 100; i += 1) {
        total += 1;
        window.push(row({ id: total, protocol: "SOME/IP", source: "a", key: `k:${total % 5}`, dir: "rx" }));
      }
      if (window.length > capacity) window.splice(0, window.length - capacity);
      const rows: TraceRows = {
        length: window.length,
        epoch: 0,
        startSequence: total - window.length,
        endSequence: total,
        get: (index) => window[index] as TraceFrame,
      };
      const view = projection.project(rows, step % 2 === 0 ? "fixed" : "sequential", new Set(), 200_000, rx);
      expect(view.length).toBeGreaterThan(0);
    }
    const internal = projection as unknown as { matching: number[]; matchingHead: number };
    // 20,000 matching rows went through a 1,000-row ring: retained state is O(ring), not O(total).
    expect(internal.matching.length - internal.matchingHead).toBeLessThanOrEqual(capacity);
    expect(internal.matching.length).toBeLessThanOrEqual(capacity + 4_096 + 100);
  });
});
