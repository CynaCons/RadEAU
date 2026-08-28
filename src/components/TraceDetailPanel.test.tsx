import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FrameDetail } from "../runtime/desktop";
import { TraceDetailBody } from "./TraceDetailPanel";

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
  bytes: `${"00".repeat(42)}${"A1".repeat(16)}${"B2".repeat(2)}`,
};

const MALFORMED_DETAIL: FrameDetail = {
  ...SOMEIP_DETAIL,
  idx: 7,
  layers: [
    ...SOMEIP_DETAIL.layers.slice(0, 2),
    {
      protocol: "User Datagram Protocol",
      summary: "malformed: truncated UDP length",
      fields: [{ name: "Length", value: "4", offset: 38, len: 2 }],
    },
  ],
};

describe("TraceDetailBody", () => {
  it("renders layers in wire order with field extents", () => {
    const html = renderToStaticMarkup(
      <TraceDetailBody idx={42} state={{ status: "ready", detail: SOMEIP_DETAIL }} />,
    );
    expect(html).toContain('data-testid="trace-detail-42"');
    expect(html).toContain('data-testid="trace-detail-layer-0"');
    expect(html).toContain('data-testid="trace-detail-layer-3"');
    expect(html).toContain("Ethernet II");
    expect(html).toContain("SOME/IP");
    // Field rows: name + mono value + offset:len hint
    expect(html).toContain("Destination");
    expect(html).toContain("0:6");
    expect(html).toContain('data-testid="trace-detail-field-extent-0-0"');
    // Layer order: Ethernet before SOME/IP in the markup
    expect(html.indexOf("Ethernet II")).toBeLessThan(html.indexOf("SOME/IP"));
  });

  it("renders hex dump at 16 bytes/row with 4-digit offsets", () => {
    const html = renderToStaticMarkup(
      <TraceDetailBody idx={42} state={{ status: "ready", detail: SOMEIP_DETAIL }} />,
    );
    expect(html).toContain('data-testid="trace-detail-payload"');
    expect(html).toContain('data-testid="trace-detail-hex-002A"');
    expect(html).toContain("002A");
    expect(html).toContain("003A");
  });

  it("omits Payload when payloadOffset == wireLen", () => {
    const detail: FrameDetail = { ...SOMEIP_DETAIL, payloadOffset: 60, wireLen: 60 };
    const html = renderToStaticMarkup(
      <TraceDetailBody idx={1} state={{ status: "ready", detail }} />,
    );
    expect(html).not.toContain('data-testid="trace-detail-payload"');
  });

  it("styles malformed layer summaries with the error token", () => {
    const html = renderToStaticMarkup(
      <TraceDetailBody idx={7} state={{ status: "ready", detail: MALFORMED_DETAIL }} />,
    );
    expect(html).toContain("malformed: truncated UDP length");
    expect(html).toContain("var(--error)");
    expect(html).toContain('data-testid="trace-detail-layer-summary-2"');
  });

  it("shows captured #idx on the first layer in Fixed mode", () => {
    const html = renderToStaticMarkup(
      <TraceDetailBody
        idx={42}
        showCapturedIdx
        state={{ status: "ready", detail: SOMEIP_DETAIL }}
      />,
    );
    expect(html).toContain('data-testid="trace-detail-captured-idx"');
    expect(html).toContain("#42");
  });

  it("renders honest empty states for evicted / unknown / browser", () => {
    for (const message of [
      "frame no longer buffered",
      "unknown frame",
      "frame dissection is desktop-only",
    ] as const) {
      const html = renderToStaticMarkup(
        <TraceDetailBody idx={3} state={{ status: "error", message }} />,
      );
      expect(html).toContain('data-testid="trace-detail-3"');
      expect(html).toContain('data-testid="trace-detail-empty"');
      expect(html).toContain(message);
      expect(html).not.toContain("Ethernet II");
    }
  });

  it("renders a loading progress row", () => {
    const html = renderToStaticMarkup(
      <TraceDetailBody idx={9} state={{ status: "loading" }} />,
    );
    expect(html).toContain('data-testid="trace-detail-loading"');
  });
});
