import { describe, expect, it } from "vitest";

import type { TraceFrame } from "./frameModel";
import {
  collapseFixed,
  fixedDisplayKey,
  projectDisplayRows,
  windowSequential,
} from "./traceDisplay";

function row(partial: Partial<TraceFrame> & Pick<TraceFrame, "id" | "protocol" | "source">): TraceFrame {
  return {
    time: "0.0000",
    dir: "rx",
    sourceTitle: partial.source,
    serviceMethod: "0x1101:0x8001",
    name: "CameraObjects.ObjectList",
    type: "Event",
    session: "--",
    length: "100",
    payload: "DE AD",
    deltaGlobal: "--",
    deltaKey: "--",
    channel: "1",
    ...partial,
  };
}

describe("fixedDisplayKey", () => {
  it("keys SOME/IP by protocol + service:method", () => {
    expect(
      fixedDisplayKey(
        row({
          id: 1,
          protocol: "SOME/IP",
          source: "10.42.0.11",
          serviceMethod: "0x1101:0x8001",
        }),
      ),
    ).toBe("SOME/IP:0x1101:0x8001");
  });

  it("keys SD and gPTP by protocol + source node", () => {
    expect(
      fixedDisplayKey(row({ id: 2, protocol: "SD", source: "camera", serviceMethod: "0xFFFF:0x8100" })),
    ).toBe("SD:camera");
    expect(
      fixedDisplayKey(row({ id: 3, protocol: "gPTP", source: "radar", serviceMethod: "--" })),
    ).toBe("gPTP:radar");
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
        deltaKey: "--",
      }),
      row({
        id: 2,
        time: "1.1000",
        protocol: "SOME/IP",
        source: "a",
        serviceMethod: "0x1101:0x8001",
        deltaKey: "0.1000",
      }),
      row({
        id: 3,
        time: "1.2000",
        protocol: "SOME/IP",
        source: "b",
        serviceMethod: "0x1102:0x8001",
        deltaKey: "--",
      }),
      row({ id: 4, time: "1.3000", protocol: "SD", source: "camera", deltaKey: "--" }),
      row({ id: 5, time: "1.4000", protocol: "SD", source: "radar", deltaKey: "--" }),
      row({ id: 6, time: "1.5000", protocol: "SD", source: "camera", deltaKey: "0.2000" }),
      row({ id: 7, time: "1.6000", protocol: "gPTP", source: "fusion", deltaKey: "--" }),
    ];
    const collapsed = collapseFixed(rows, new Set());
    expect(collapsed.map((r) => r.id).sort((a, b) => a - b)).toEqual([2, 3, 5, 6, 7]);
    // SD/camera kept the later rewrite with live cycle time.
    const sdCamera = collapsed.find((r) => r.protocol === "SD" && r.source === "camera");
    expect(sdCamera?.deltaKey).toBe("0.2000");
    expect(sdCamera?.id).toBe(6);
  });

  it("orders pinned rows first, then key ascending", () => {
    const rows = [
      row({ id: 1, protocol: "SOME/IP", source: "a", serviceMethod: "0x1102:0x8001" }),
      row({ id: 2, protocol: "SOME/IP", source: "a", serviceMethod: "0x1101:0x8001" }),
      row({ id: 3, protocol: "gPTP", source: "zulu" }),
      row({ id: 4, protocol: "SD", source: "alpha" }),
    ];
    const pinned = new Set(["gPTP:zulu", "SOME/IP:0x1102:0x8001"]);
    const collapsed = collapseFixed(rows, pinned);
    expect(collapsed.map(fixedDisplayKey)).toEqual([
      "SOME/IP:0x1102:0x8001",
      "gPTP:zulu",
      "SD:alpha",
      "SOME/IP:0x1101:0x8001",
    ]);
  });

  it("rebuilds from the buffered ring on mode switch (no clear)", () => {
    const ring = [
      row({ id: 1, protocol: "SOME/IP", source: "a", serviceMethod: "0x1101:0x8001", time: "0.1000" }),
      row({
        id: 2,
        protocol: "SOME/IP",
        source: "a",
        serviceMethod: "0x1101:0x8001",
        time: "0.2000",
        deltaKey: "0.1000",
      }),
      row({ id: 3, protocol: "SD", source: "cam", time: "0.2500" }),
    ];
    // Sequential window then Fixed rebuild — same ring, different projection.
    expect(projectDisplayRows(ring, "sequential", new Set(), 200_000)).toHaveLength(3);
    const fixed = projectDisplayRows(ring, "fixed", new Set(), 200_000);
    expect(fixed).toHaveLength(2);
    // Key ascending: "SD:cam" < "SOME/IP:…"
    expect(fixed.map((r) => r.id)).toEqual([3, 2]);
    expect(fixed[1].deltaKey).toBe("0.1000");
  });
});

describe("windowSequential", () => {
  it("returns the last N rows", () => {
    const rows = [1, 2, 3, 4, 5].map((id) =>
      row({ id, protocol: "SOME/IP", source: "a", serviceMethod: "0x1101:0x8001" }),
    );
    expect(windowSequential(rows, 3).map((r) => r.id)).toEqual([3, 4, 5]);
    expect(windowSequential(rows, 10)).toBe(rows);
  });
});
