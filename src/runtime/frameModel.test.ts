import { afterEach, describe, expect, it } from "vitest";

import {
  ENDPOINTS,
  getSessionEndpoints,
  projectRow,
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
