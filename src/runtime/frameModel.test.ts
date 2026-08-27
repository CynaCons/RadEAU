import { afterEach, describe, expect, it } from "vitest";

import {
  deltaKeyOf,
  ENDPOINTS,
  getSessionEndpoints,
  projectRow,
  PROTO_GPTP,
  PROTO_SD,
  PROTO_SOMEIP,
  resolveEndpoint,
  setSessionEndpoints,
  type FrameBatchRaw,
} from "./frameModel";

function oneRowBatch(s: number): FrameBatchRaw {
  return {
    seq: 0,
    i: [1],
    t: [0.5],
    d: [1],
    s: [s],
    p: [PROTO_SOMEIP],
    sv: [0x1101],
    m: [0x8001],
    ty: [0],
    se: [1],
    l: [100],
    pb: [[0xde, 0xad]],
  };
}

describe("endpoint resolution", () => {
  afterEach(() => {
    setSessionEndpoints(null);
  });

  it("falls back to the static ENDPOINTS table", () => {
    expect(getSessionEndpoints()).toBeNull();
    expect(resolveEndpoint(0)).toEqual({ label: ENDPOINTS[0], title: ENDPOINTS[0] });
    expect(resolveEndpoint(4)).toEqual({ label: ENDPOINTS[4], title: ENDPOINTS[4] });
    expect(resolveEndpoint(99)).toEqual({ label: "ep-99", title: "ep-99" });
  });

  it("prefers session port names with IP tooltips", () => {
    setSessionEndpoints([
      { name: "camera", ip: "10.42.0.11" },
      { name: "radar", ip: "10.42.0.12" },
      { name: "fusion", ip: "10.42.0.20" },
    ]);
    expect(resolveEndpoint(0)).toEqual({
      label: "camera",
      title: "camera (10.42.0.11)",
    });
    expect(resolveEndpoint(2)).toEqual({
      label: "fusion",
      title: "fusion (10.42.0.20)",
    });
  });

  it("uses the IP when session name equals ip (devgen-shaped session)", () => {
    setSessionEndpoints([{ name: "10.42.0.11", ip: "10.42.0.11" }]);
    expect(resolveEndpoint(0)).toEqual({ label: "10.42.0.11", title: "10.42.0.11" });
  });

  it("projects the resolved label into TraceFrame.source / sourceTitle", () => {
    setSessionEndpoints([{ name: "camera", ip: "10.42.0.11" }]);
    const row = projectRow(oneRowBatch(0), 0, null, new Map());
    expect(row.source).toBe("camera");
    expect(row.sourceTitle).toBe("camera (10.42.0.11)");
  });
});

describe("deltaKeyOf", () => {
  it("keys SOME/IP by protocol + service + method", () => {
    expect(deltaKeyOf(PROTO_SOMEIP, 0x1101, 0x8001, 0)).toBe("0:4353:32769");
    expect(deltaKeyOf(PROTO_SOMEIP, 0x1101, 0x8001, 3)).toBe("0:4353:32769");
  });

  it("keys SD and gPTP by protocol + source endpoint", () => {
    expect(deltaKeyOf(PROTO_SD, 0xffff, 0x8100, 0)).toBe("1:ep0");
    expect(deltaKeyOf(PROTO_SD, 0xffff, 0x8100, 2)).toBe("1:ep2");
    expect(deltaKeyOf(PROTO_GPTP, 0, 0, 4)).toBe("2:ep4");
  });

  it("computes per-node cycle time for SD offers from different sources", () => {
    const lastByKey = new Map<string, number>();
    const batch = (s: number, t: number, idx: number): FrameBatchRaw => ({
      seq: 0,
      i: [idx],
      t: [t],
      d: [1],
      s: [s],
      p: [PROTO_SD],
      sv: [0xffff],
      m: [0x8100],
      ty: [1],
      se: [-1],
      l: [80],
      pb: [[0xaa]],
    });
    const a0 = projectRow(batch(0, 1.0, 1), 0, null, lastByKey);
    lastByKey.set(deltaKeyOf(PROTO_SD, 0xffff, 0x8100, 0), 1.0);
    const b0 = projectRow(batch(1, 1.1, 2), 0, 1.0, lastByKey);
    lastByKey.set(deltaKeyOf(PROTO_SD, 0xffff, 0x8100, 1), 1.1);
    const a1 = projectRow(batch(0, 1.5, 3), 0, 1.1, lastByKey);
    expect(a0.deltaKey).toBe("--");
    expect(b0.deltaKey).toBe("--"); // different node — first sample
    expect(a1.deltaKey).toBe("0.5000"); // cycle vs prior ep0 offer
  });
});
