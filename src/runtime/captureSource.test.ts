import { describe, expect, it } from "vitest";

import {
  buildCaptureSource,
  captureButtonLabel,
  defaultSourceKind,
  DEFAULT_LIVE_BPF_FILTER,
  DEFAULT_PCAP_PACE,
  DEFAULT_SIM_ADDR,
  droppedBreakdownTooltip,
  emptyByClass,
  interfaceLockedReason,
  liveInterfacePrimaryLabel,
  liveInterfaceSecondaryText,
  liveSourceAvailable,
  liveSourceDisabledReason,
  linkChipColorVar,
  linkChipLabel,
  lossTotal,
  pcapPaceCaption,
  pcapSourceAvailable,
  showDegradedLinkChip,
  showLiveInterfaceFields,
  showPcapPathField,
  showPcapStreamAddrField,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
  sourceKindLabel,
  type CaptureStats,
  type InterfaceInfo,
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
    recordingFrames: 0,
    recordingBytes: 0,
    recordingDropped: 0,
    ...partial,
  };
}

const LOOPBACK: InterfaceInfo = {
  id: "\\Device\\NPF_Loopback",
  name: "Adapter for loopback traffic capture",
  description: "Npcap Loopback Adapter",
  addresses: ["127.0.0.1", "::1"],
  up: true,
  loopback: true,
};

describe("defaultSourceKind", () => {
  it("prefers the Dev generator when the build exposes it", () => {
    expect(
      defaultSourceKind({ devgenAvailable: true, liveCaptureInstalled: true }),
    ).toBe("devgen");
    expect(
      defaultSourceKind({ devgenAvailable: true, liveCaptureInstalled: false }),
    ).toBe("devgen");
  });

  it("falls back to live when Npcap/libpcap is installed", () => {
    expect(
      defaultSourceKind({ devgenAvailable: false, liveCaptureInstalled: true }),
    ).toBe("live");
  });

  it("falls back to pcap when neither devgen nor live is available", () => {
    expect(
      defaultSourceKind({ devgenAvailable: false, liveCaptureInstalled: false }),
    ).toBe("pcap");
  });
});

describe("captureSource picker state", () => {
  it("builds tagged CaptureSource values including pcap, pcapStream, and live", () => {
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

    expect(
      buildCaptureSource("live", {
        interfaceId: "  eth0  ",
        filter: "  udp  ",
      }),
    ).toEqual({ kind: "live", interfaceId: "eth0", filter: "udp" });
    expect(buildCaptureSource("live", { interfaceId: "lo" })).toEqual({
      kind: "live",
      interfaceId: "lo",
      filter: null,
    });
    expect(buildCaptureSource("live", { interfaceId: "lo", filter: "   " })).toEqual({
      kind: "live",
      interfaceId: "lo",
      filter: null,
    });
    expect(buildCaptureSource("live", { interfaceId: "lo", filter: null })).toEqual({
      kind: "live",
      interfaceId: "lo",
      filter: null,
    });
  });

  it("gates sim/pcap/live availability and locks Interface controls while running", () => {
    expect(simSourceAvailable(true)).toBe(true);
    expect(simSourceAvailable(false)).toBe(false);
    expect(pcapSourceAvailable(true)).toBe(true);
    expect(pcapSourceAvailable(false)).toBe(false);
    expect(liveSourceAvailable(true, "installed")).toBe(true);
    expect(liveSourceAvailable(true, "missing")).toBe(false);
    expect(liveSourceAvailable(true, "blocked")).toBe(false);
    expect(liveSourceAvailable(true, "incompatible")).toBe(false);
    expect(liveSourceAvailable(true, "not-applicable")).toBe(false);
    expect(liveSourceAvailable(true, null)).toBe(false);
    expect(liveSourceAvailable(false, "installed")).toBe(false);
    expect(liveSourceDisabledReason("windows")).toBe("requires Npcap — see Dependencies");
    expect(liveSourceDisabledReason("linux")).toBe("requires libpcap — see Dependencies");
    expect(liveSourceDisabledReason("other")).toBe("requires Npcap — see Dependencies");
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
    expect(showLiveInterfaceFields("live")).toBe(true);
    expect(showLiveInterfaceFields("sim")).toBe(false);
  });

  it("labels live interface options from description ?? name and addresses", () => {
    expect(liveInterfacePrimaryLabel(LOOPBACK)).toBe("Npcap Loopback Adapter");
    expect(liveInterfaceSecondaryText(LOOPBACK)).toBe("127.0.0.1, ::1");
    expect(
      liveInterfacePrimaryLabel({
        ...LOOPBACK,
        description: null,
      }),
    ).toBe("Adapter for loopback traffic capture");
    expect(
      liveInterfacePrimaryLabel({
        ...LOOPBACK,
        description: "   ",
      }),
    ).toBe("Adapter for loopback traffic capture");
    expect(
      liveInterfaceSecondaryText({
        ...LOOPBACK,
        addresses: [],
      }),
    ).toBe("");
  });

  it("shows the Trace link chip for degraded sim, pcapStream, and live links", () => {
    expect(showDegradedLinkChip(true, "sim", "connecting")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "reconnecting")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "error")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "connected")).toBe(false);
    expect(showDegradedLinkChip(true, "sim", "closed")).toBe(false);
    expect(showDegradedLinkChip(true, "pcapStream", "reconnecting")).toBe(true);
    expect(showDegradedLinkChip(true, "pcapStream", "closed")).toBe(false);
    expect(showDegradedLinkChip(true, "live", "error")).toBe(true);
    expect(showDegradedLinkChip(true, "live", "connecting")).toBe(true);
    expect(showDegradedLinkChip(true, "live", "connected")).toBe(false);
    expect(showDegradedLinkChip(true, "live", "closed")).toBe(false);
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
    expect(sourceKindLabel("live")).toBe("Physical interface");
  });

  it("labels the capture button from source kind", () => {
    expect(captureButtonLabel(false, "devgen")).toContain("dev generator");
    expect(captureButtonLabel(false, "sim")).toContain("simulator");
    expect(captureButtonLabel(false, "pcap")).toContain("pcap file");
    expect(captureButtonLabel(false, "pcapStream")).toContain("pcap stream");
    expect(captureButtonLabel(false, "live")).toContain("physical interface");
    expect(captureButtonLabel(true, "sim")).toBe("Stop capture");
  });

  it("explains pcap pace modes and the default live BPF", () => {
    expect(pcapPaceCaption("realtime")).toMatch(/timestamp/i);
    expect(pcapPaceCaption("fast")).toMatch(/accumulator/i);
    expect(DEFAULT_LIVE_BPF_FILTER).toBe("udp or ether proto 0x88f7 or arp or vlan");
  });

  it("sums loss counters for the Dropped chip and builds the breakdown tooltip", () => {
    expect(lossTotal(stats())).toBe(0);
    expect(
      lossTotal(
        stats({
          accumulatorDropped: 3,
          gapDropped: 5,
          kernelDropped: 7,
          recordingDropped: 2,
          gapRecords: 2,
        }),
      ),
    ).toBe(17);
    expect(
      droppedBreakdownTooltip(
        stats({
          accumulatorDropped: 3,
          gapDropped: 5,
          kernelDropped: 7,
          recordingDropped: 2,
        }),
      ),
    ).toBe("Accumulator 3 · Gap 5 · Kernel 7 · Recording 2");
    expect(emptyByClass()).toHaveLength(PROTO_CLASS_COUNT);
  });
});
