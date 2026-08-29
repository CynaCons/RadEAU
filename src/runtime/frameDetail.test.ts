import { describe, expect, it } from "vitest";

import type { FrameDetail } from "./desktop";
import { fetchFrameDetail } from "./desktop";
import {
  captureTraceExpansion,
  formatFieldExtent,
  formatHexDump,
  formatScaled,
  frameDetailErrorMessage,
  isMalformedLayerSummary,
  rowMatchesExpansion,
} from "./frameDetail";
import type { TraceFrame } from "./frameModel";

/** Fixture: Ethernet → IPv4 → UDP → SOME/IP with an 18-byte payload. */
const SOMEIP_DETAIL: FrameDetail = {
  idx: 42,
  tS: 1.25,
  wireLen: 60,
  payloadOffset: 42,
  layers: [
    {
      protocol: "Ethernet II",
      summary: "Src: aa:bb:cc:dd:ee:ff, Dst: 11:22:33:44:55:66",
      fields: [
        { name: "Destination", value: "11:22:33:44:55:66", offset: 0, len: 6 },
        { name: "Source", value: "aa:bb:cc:dd:ee:ff", offset: 6, len: 6 },
        { name: "Type", value: "IPv4 (0x0800)", offset: 12, len: 2 },
      ],
    },
    {
      protocol: "Internet Protocol Version 4",
      summary: "Src: 10.42.0.11, Dst: 10.42.0.1",
      fields: [
        { name: "Version", value: "4", offset: 14, len: 1 },
        { name: "Source Address", value: "10.42.0.11", offset: 26, len: 4 },
      ],
    },
    {
      protocol: "User Datagram Protocol",
      summary: "Src Port: 30509, Dst Port: 30490",
      fields: [{ name: "Source Port", value: "30509", offset: 34, len: 2 }],
    },
    {
      protocol: "SOME/IP",
      summary: "Service 0x1101 Method 0x8001",
      fields: [
        { name: "Service ID", value: "0x1101", offset: 42, len: 2 },
        { name: "Method ID", value: "0x8001", offset: 44, len: 2 },
      ],
    },
  ],
  // Exactly 60 bytes (120 hex chars). Payload = last 18 bytes from offset 42.
  bytes: `${"00".repeat(42)}${"A1".repeat(16)}${"B2".repeat(2)}`,
  decoded: null,
};

/** Minimal TraceFrame for expansion-slot tests. */
function frame(partial: Partial<TraceFrame> & Pick<TraceFrame, "id" | "protocol" | "serviceMethod" | "source">): TraceFrame {
  return {
    time: "0.0000",
    dir: "rx",
    sourceTitle: partial.source,
    name: "n",
    type: "Notification",
    session: "1",
    length: "64",
    payload: "00",
    deltaGlobal: "0.0000",
    deltaKey: "0.0000",
    channel: "0",
    key: `${partial.protocol}:${partial.serviceMethod}`,
    proto: 0,
    sv: 0,
    m: 0,
    srcEp: 0,
    ty: 0,
    sa: 0,
    da: 0,
    sm: 0,
    vl: -1,
    ...partial,
  };
}

describe("formatHexDump", () => {
  it("formats 16 bytes per row with 4-digit uppercase offsets", () => {
    const rows = formatHexDump(SOMEIP_DETAIL.bytes, SOMEIP_DETAIL.payloadOffset, SOMEIP_DETAIL.wireLen);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(2);
    expect(rows![0].offsetLabel).toBe("002A");
    expect(rows![0].hex.split(" ")).toHaveLength(16);
    expect(rows![0].hex).toMatch(/^[0-9A-F]{2}( [0-9A-F]{2}){15}$/);
    expect(rows![1].offsetLabel).toBe("003A");
    expect(rows![1].hex.split(" ").length).toBeLessThanOrEqual(16);
  });

  it("omits the dump when payloadOffset == wireLen", () => {
    expect(formatHexDump(SOMEIP_DETAIL.bytes, 60, 60)).toBeNull();
  });

  it("starts the dump at payloadOffset within the full frame bytes", () => {
    const bytes = "00112233445566778899AABBCCDDEEFF"; // 16 bytes
    const rows = formatHexDump(bytes, 8, 16);
    expect(rows).toEqual([
      { offsetLabel: "0008", hex: "88 99 AA BB CC DD EE FF" },
    ]);
  });
});

describe("formatFieldExtent", () => {
  it("renders offset:len", () => {
    expect(formatFieldExtent(14, 4)).toBe("14:4");
  });
});

describe("formatScaled", () => {
  it("keeps integers as plain decimal strings", () => {
    expect(formatScaled(10)).toBe("10");
    expect(formatScaled(0)).toBe("0");
  });

  it("trims trailing zeros at a sensible precision", () => {
    expect(formatScaled(12.34)).toBe("12.34");
    expect(formatScaled(1.0)).toBe("1");
    expect(formatScaled(0.01)).toBe("0.01");
    expect(formatScaled(0.001)).toBe("0.001");
  });

  it("passes through non-finite values honestly", () => {
    expect(formatScaled(Number.NaN)).toBe("NaN");
    expect(formatScaled(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});

describe("isMalformedLayerSummary", () => {
  it("detects the core malformed prefix", () => {
    expect(isMalformedLayerSummary("malformed: truncated UDP length")).toBe(true);
    expect(isMalformedLayerSummary("Src Port: 30509")).toBe(false);
  });
});

describe("frameDetailErrorMessage", () => {
  it("maps browser / core rejections to honest empty-state copy", () => {
    expect(frameDetailErrorMessage(new Error("desktop app only"))).toBe(
      "frame dissection is desktop-only",
    );
    expect(frameDetailErrorMessage(new Error("frame no longer buffered"))).toBe(
      "frame no longer buffered",
    );
    expect(frameDetailErrorMessage(new Error("unknown frame"))).toBe("unknown frame");
  });

  it("passes through unexpected messages honestly", () => {
    expect(frameDetailErrorMessage(new Error("disk full"))).toBe("disk full");
  });
});

describe("fetchFrameDetail (browser / node)", () => {
  it("rejects with desktop app only outside the Tauri shell", async () => {
    await expect(fetchFrameDetail(0)).rejects.toThrow("desktop app only");
  });
});

describe("fixed-mode idx capture", () => {
  it("captures idx at expand time and keys the slot by display key", () => {
    const first = frame({
      id: 10,
      protocol: "SOME/IP",
      serviceMethod: "0x1101:0x8001",
      source: "10.42.0.11",
    });
    const rewritten = frame({
      id: 99,
      protocol: "SOME/IP",
      serviceMethod: "0x1101:0x8001",
      source: "10.42.0.11",
    });
    const expansion = captureTraceExpansion("fixed", first);
    expect(expansion.idx).toBe(10);
    expect(expansion.showCapturedIdx).toBe(true);
    // Same Fixed slot after rewrite — still expanded, still inspecting #10.
    expect(rowMatchesExpansion("fixed", rewritten, expansion)).toBe(true);
    expect(expansion.idx).toBe(10);
  });

  it("keys Sequential expansion by frame id", () => {
    const a = frame({
      id: 7,
      protocol: "gPTP",
      serviceMethod: "—",
      source: "10.42.0.11",
    });
    const b = frame({
      id: 8,
      protocol: "gPTP",
      serviceMethod: "—",
      source: "10.42.0.11",
    });
    const expansion = captureTraceExpansion("sequential", a);
    expect(expansion.showCapturedIdx).toBe(false);
    expect(rowMatchesExpansion("sequential", a, expansion)).toBe(true);
    expect(rowMatchesExpansion("sequential", b, expansion)).toBe(false);
  });
});

describe("SOME/IP fixture layer order", () => {
  it("lists layers in wire order", () => {
    expect(SOMEIP_DETAIL.layers.map((l) => l.protocol)).toEqual([
      "Ethernet II",
      "Internet Protocol Version 4",
      "User Datagram Protocol",
      "SOME/IP",
    ]);
  });
});
