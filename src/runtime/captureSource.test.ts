import { describe, expect, it } from "vitest";

import {
  buildCaptureSource,
  captureButtonLabel,
  DEFAULT_PCAP_PACE,
  DEFAULT_SIM_ADDR,
  emptyByClass,
  interfaceLockedReason,
  linkChipColorVar,
  linkChipLabel,
  lossTotal,
  pcapPaceCaption,
  pcapSourceAvailable,
  showDegradedLinkChip,
  showPcapPathField,
  showPcapStreamAddrField,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
  sourceKindLabel,
  type CaptureStats,
} from "./captureSource";
import { PROTO_CLASS_COUNT } from "./wireCodes";

function stats(partial: Partial<CaptureStats> = {}): CaptureStats {
  return {
    seq: 0,
    elapsedS: 1,
    received: 100,
    emitted: 90,
    accumulatorDropped: 0,
    gapRecords: 0,
    gapDropped: 0,
    malformed: 0,
    kernelDropped: 0,
    byClass: emptyByClass(),
    ...partial,
  };
}

describe("captureSource picker state", () => {
  it("builds tagged CaptureSource values including pcap and pcapStream", () => {
    expect(buildCaptureSource("devgen")).toEqual({ kind: "devgen", profile: "normal" });
    expect(buildCaptureSource("devgen", { profile: "stress" })).toEqual({
      kind: "devgen",
      profile: "stress",
    });
    expect(buildCaptureSource("sim")).toEqual({ kind: "sim", addr: DEFAULT_SIM_ADDR });
    expect(buildCaptureSource("sim", { addr: " 10.0.0.1:5560 " })).toEqual({
      kind: "sim",
      addr: "10.0.0.1:5560",
    });
    const blank = buildCaptureSource("sim", { addr: "   " });
    expect(blank.kind).toBe("sim");
    if (blank.kind === "sim") expect(blank.addr).toBe(DEFAULT_SIM_ADDR);

    expect(buildCaptureSource("pcap", { path: "  a.pcap  ", pace: "fast" })).toEqual({
      kind: "pcap",
      path: "a.pcap",
      pace: "fast",
    });
    expect(buildCaptureSource("pcap")).toEqual({
      kind: "pcap",
      path: "",
      pace: DEFAULT_PCAP_PACE,
    });
    expect(buildCaptureSource("pcapStream", { streamAddr: " 127.0.0.1:5561 " })).toEqual({
      kind: "pcapStream",
      addr: "127.0.0.1:5561",
    });
    expect(buildCaptureSource("pcapStream")).toEqual({ kind: "pcapStream", addr: "" });
  });

  it("gates sim/pcap availability and locks Interface controls while running", () => {
    expect(simSourceAvailable(true)).toBe(true);
    expect(simSourceAvailable(false)).toBe(false);
    expect(pcapSourceAvailable(true)).toBe(true);
    expect(pcapSourceAvailable(false)).toBe(false);
    expect(sourceControlsDisabled(false)).toBe(false);
    expect(sourceControlsDisabled(true)).toBe(true);
    expect(interfaceLockedReason(false)).toBeNull();
    expect(interfaceLockedReason(true)).toMatch(/session is running/i);
    expect(showSimAddressField("sim")).toBe(true);
    expect(showSimAddressField("devgen")).toBe(false);
    expect(showPcapPathField("pcap")).toBe(true);
    expect(showPcapPathField("sim")).toBe(false);
    expect(showPcapStreamAddrField("pcapStream")).toBe(true);
    expect(showPcapStreamAddrField("pcap")).toBe(false);
  });

  it("shows the Trace link chip for degraded sim and pcapStream links, never closed", () => {
    expect(showDegradedLinkChip(true, "sim", "connecting")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "reconnecting")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "error")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "connected")).toBe(false);
    expect(showDegradedLinkChip(true, "sim", "closed")).toBe(false);
    expect(showDegradedLinkChip(true, "pcapStream", "reconnecting")).toBe(true);
    expect(showDegradedLinkChip(true, "pcapStream", "closed")).toBe(false);
    expect(showDegradedLinkChip(true, "pcap", "error")).toBe(false);
    expect(showDegradedLinkChip(true, "devgen", "reconnecting")).toBe(false);
    expect(showDegradedLinkChip(false, "sim", "reconnecting")).toBe(false);
    expect(showDegradedLinkChip(true, "sim", null)).toBe(false);
  });

  it("maps link chip labels, source labels, and token color vars", () => {
    expect(linkChipLabel("connected")).toBe("Connected");
    expect(linkChipLabel("reconnecting")).toBe("Reconnecting");
    expect(linkChipLabel("closed")).toBe("Closed");
    expect(linkChipColorVar("connected")).toBe("var(--success)");
    expect(linkChipColorVar("error")).toBe("var(--error)");
    expect(linkChipColorVar("connecting")).toBe("var(--warning)");
    expect(linkChipColorVar("closed")).toBe("var(--text-secondary)");
    expect(sourceKindLabel("devgen")).toBe("Dev generator");
    expect(sourceKindLabel("sim")).toBe("Simulator link");
    expect(sourceKindLabel("pcap")).toBe("pcap file");
    expect(sourceKindLabel("pcapStream")).toBe("pcap stream");
  });

  it("labels the capture button from source kind", () => {
    expect(captureButtonLabel(false, "devgen")).toContain("dev generator");
    expect(captureButtonLabel(false, "sim")).toContain("simulator");
    expect(captureButtonLabel(false, "pcap")).toContain("pcap file");
    expect(captureButtonLabel(false, "pcapStream")).toContain("pcap stream");
    expect(captureButtonLabel(true, "sim")).toBe("Stop capture");
  });

  it("explains pcap pace modes", () => {
    expect(pcapPaceCaption("realtime")).toMatch(/timestamp/i);
    expect(pcapPaceCaption("fast")).toMatch(/accumulator/i);
  });

  it("sums loss counters for the Dropped chip", () => {
    expect(lossTotal(stats())).toBe(0);
    expect(
      lossTotal(
        stats({ accumulatorDropped: 3, gapDropped: 5, kernelDropped: 7, gapRecords: 2 }),
      ),
    ).toBe(15);
    expect(emptyByClass()).toHaveLength(PROTO_CLASS_COUNT);
  });
});
