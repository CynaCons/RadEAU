import { describe, expect, it } from "vitest";

import type { TraceFrame } from "./frameModel";
import { projectDisplayRows } from "./traceDisplay";
import {
  applyFilter,
  distinctValues,
  EMPTY_FILTER,
  isFilterActive,
  matches,
  serviceMethodId,
  type TraceFilter,
  windowSequentialFiltered,
} from "./traceFilter";
import { PROTO_GPTP, PROTO_SD, PROTO_SOMEIP } from "./wireCodes";

function row(
  partial: Partial<TraceFrame> & Pick<TraceFrame, "id" | "protocol" | "source" | "key">,
): TraceFrame {
  return {
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
    proto: PROTO_SOMEIP,
    sv: 0x1101,
    m: 0x8001,
    srcEp: 0,
    ty: 0,
    sa: 0,
    da: 0,
    sm: 0,
    vl: -1,
    ...partial,
  };
}

describe("isFilterActive / applyFilter fast path", () => {
  it("EMPTY_FILTER is inactive and applyFilter returns the same reference", () => {
    const rows = [
      row({ id: 1, protocol: "SOME/IP", source: "a", key: "0:4353:32769" }),
    ];
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(applyFilter(rows, EMPTY_FILTER)).toBe(rows);
  });

  it("any non-null column makes the filter active", () => {
    expect(isFilterActive({ ...EMPTY_FILTER, protocols: new Set([PROTO_GPTP]) })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, dirs: new Set() })).toBe(true);
  });
});

describe("matches — per column", () => {
  const base = row({
    id: 1,
    protocol: "SOME/IP",
    source: "a",
    key: "0:4353:32769",
    proto: PROTO_SOMEIP,
    sv: 0x1101,
    m: 0x8001,
    dir: "rx",
    name: "CameraObjects.ObjectList",
    serviceMethod: "0x1101:0x8001",
  });

  it("filters by service id pair", () => {
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      services: new Set(["4353:32769"]),
    };
    expect(matches(base, f)).toBe(true);
    expect(matches({ ...base, sv: 0x1102, m: 0x8001 }, f)).toBe(false);
  });

  it("filters by name via the same id pair (not the display string)", () => {
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      names: new Set(["4353:32769"]),
    };
    expect(matches(base, f)).toBe(true);
    expect(matches({ ...base, name: "Renamed.ByCatalog" }, f)).toBe(true);
    expect(matches({ ...base, sv: 0x1103 }, f)).toBe(false);
  });

  it("filters by protocol integer", () => {
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_GPTP]),
    };
    expect(matches(base, f)).toBe(false);
    expect(matches({ ...base, proto: PROTO_GPTP, protocol: "gPTP" }, f)).toBe(true);
  });

  it("filters by direction", () => {
    const f: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["tx"]) };
    expect(matches(base, f)).toBe(false);
    expect(matches({ ...base, dir: "tx" }, f)).toBe(true);
  });

  it("empty Set matches nothing", () => {
    const f: TraceFilter = { ...EMPTY_FILTER, protocols: new Set() };
    expect(matches(base, f)).toBe(false);
  });
});

describe("distinctValues", () => {
  it("keys Service and Name by sv:m and lists display labels with counts", () => {
    const rows = [
      row({
        id: 1,
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        sv: 0x1101,
        m: 0x8001,
        serviceMethod: "0x1101:0x8001",
        name: "CameraObjects.ObjectList",
      }),
      row({
        id: 2,
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        sv: 0x1101,
        m: 0x8001,
        serviceMethod: "0x1101:0x8001",
        name: "CameraObjects.ObjectList",
      }),
      row({
        id: 3,
        protocol: "SOME/IP",
        source: "b",
        key: "0:4355:32769",
        sv: 0x1103,
        m: 0x8001,
        serviceMethod: "0x1103:0x8001",
        name: "LidarClusters.ClusterList",
      }),
    ];
    const services = distinctValues(rows, "service");
    expect(services).toEqual([
      { key: "4353:32769", label: "0x1101:0x8001", count: 2 },
      { key: "4355:32769", label: "0x1103:0x8001", count: 1 },
    ]);
    const names = distinctValues(rows, "name");
    expect(names.map((o) => o.key)).toEqual(["4353:32769", "4355:32769"]);
    expect(names.find((o) => o.key === "4355:32769")?.label).toBe(
      "LidarClusters.ClusterList",
    );
  });

  it("lists protocols by PROTO_* key and dirs by dir string", () => {
    const rows = [
      row({ id: 1, protocol: "gPTP", source: "a", key: "2:1:0", proto: PROTO_GPTP, dir: "rx" }),
      row({ id: 2, protocol: "SD", source: "b", key: "1:2", proto: PROTO_SD, dir: "tx" }),
      row({ id: 3, protocol: "gPTP", source: "a", key: "2:1:0", proto: PROTO_GPTP, dir: "rx" }),
    ];
    expect(distinctValues(rows, "protocol")).toEqual([
      { key: String(PROTO_SD), label: "SD", count: 1 },
      { key: String(PROTO_GPTP), label: "gPTP", count: 2 },
    ]);
    expect(distinctValues(rows, "dir")).toEqual([
      { key: "rx", label: "Rx", count: 2 },
      { key: "tx", label: "Tx", count: 1 },
    ]);
  });
});

describe("projectDisplayRows + filter", () => {
  it("Fixed shows the latest matching frame per key (not the absolute newest)", () => {
    const rows = [
      row({
        id: 1,
        time: "1.0000",
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        proto: PROTO_SOMEIP,
        dir: "rx",
      }),
      row({
        id: 2,
        time: "1.1000",
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        proto: PROTO_SOMEIP,
        dir: "tx", // newest for this key — fails Rx filter
      }),
      row({
        id: 3,
        time: "1.2000",
        protocol: "gPTP",
        source: "b",
        key: "2:1:0",
        proto: PROTO_GPTP,
        dir: "rx",
        serviceMethod: "--",
        name: "Sync · b",
        sv: 0,
        m: 0,
      }),
    ];
    const f: TraceFilter = { ...EMPTY_FILTER, dirs: new Set(["rx"]) };
    const fixed = projectDisplayRows(rows, "fixed", new Set(), 200_000, f);
    expect(fixed.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(fixed.find((r) => r.key === "0:4353:32769")?.id).toBe(1);
  });

  it("Sequential window holds N matching rows (backward scan)", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({
        id: i + 1,
        protocol: i % 2 === 0 ? "gPTP" : "SOME/IP",
        source: "a",
        key: i % 2 === 0 ? `2:${i}:0` : `0:4353:32769`,
        proto: i % 2 === 0 ? PROTO_GPTP : PROTO_SOMEIP,
      }),
    );
    // ids 1..10; even i (0,2,4,6,8) → gPTP ids 1,3,5,7,9; odd → SOME/IP
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_GPTP]),
    };
    const seq = projectDisplayRows(rows, "sequential", new Set(), 3, f);
    expect(seq.map((r) => r.id)).toEqual([5, 7, 9]);
  });

  it("backward scan equals the naive applyFilter + slice result", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({
        id: i + 1,
        protocol: i % 3 === 0 ? "gPTP" : "SOME/IP",
        source: "a",
        key: `k:${i}`,
        proto: i % 3 === 0 ? PROTO_GPTP : PROTO_SOMEIP,
        dir: i % 2 === 0 ? "rx" : "tx",
      }),
    );
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_SOMEIP]),
      dirs: new Set(["rx"]),
    };
    const window = 5;
    const naive = applyFilter(rows, f).slice(-window);
    const optimized = windowSequentialFiltered(rows, window, f);
    expect(optimized.map((r) => r.id)).toEqual(naive.map((r) => r.id));
    expect(
      projectDisplayRows(rows, "sequential", new Set(), window, f).map((r) => r.id),
    ).toEqual(naive.map((r) => r.id));
  });

  it("pinned keys do not bypass filters", () => {
    const rows = [
      row({
        id: 1,
        protocol: "SOME/IP",
        source: "a",
        key: "0:4353:32769",
        proto: PROTO_SOMEIP,
      }),
      row({
        id: 2,
        protocol: "gPTP",
        source: "b",
        key: "2:9:0",
        proto: PROTO_GPTP,
        serviceMethod: "--",
        name: "Sync · b",
        sv: 0,
        m: 0,
      }),
    ];
    const pinned = new Set(["2:9:0"]);
    const f: TraceFilter = {
      ...EMPTY_FILTER,
      protocols: new Set([PROTO_SOMEIP]),
    };
    const fixed = projectDisplayRows(rows, "fixed", pinned, 200_000, f);
    expect(fixed.map((r) => r.id)).toEqual([1]);
    expect(fixed.every((r) => r.proto === PROTO_SOMEIP)).toBe(true);
  });

  it("unfiltered Sequential keeps identity when the ring fits the window", () => {
    const rows = [
      row({ id: 1, protocol: "SOME/IP", source: "a", key: "0:4353:32769" }),
      row({ id: 2, protocol: "SOME/IP", source: "a", key: "0:4353:32769" }),
    ];
    expect(projectDisplayRows(rows, "sequential", new Set(), 200_000, EMPTY_FILTER)).toBe(
      rows,
    );
  });
});

describe("serviceMethodId", () => {
  it("formats sv:m as decimal id pair", () => {
    expect(
      serviceMethodId(
        row({ id: 1, protocol: "SOME/IP", source: "a", key: "k", sv: 0x1103, m: 0x8001 }),
      ),
    ).toBe("4355:32769");
  });
});
