import { describe, expect, it } from "vitest";

import {
  buildCaptureSource,
  captureButtonLabel,
  DEFAULT_SIM_ADDR,
  interfaceLockedReason,
  linkChipColorVar,
  linkChipLabel,
  showDegradedLinkChip,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
  sourceKindLabel,
} from "./captureSource";

describe("captureSource picker state", () => {
  it("builds tagged CaptureSource values", () => {
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
  });

  it("gates sim availability and locks Interface controls while running", () => {
    expect(simSourceAvailable(true)).toBe(true);
    expect(simSourceAvailable(false)).toBe(false);
    expect(sourceControlsDisabled(false)).toBe(false);
    expect(sourceControlsDisabled(true)).toBe(true);
    expect(interfaceLockedReason(false)).toBeNull();
    expect(interfaceLockedReason(true)).toMatch(/session is running/i);
    expect(showSimAddressField("sim")).toBe(true);
    expect(showSimAddressField("devgen")).toBe(false);
  });

  it("shows the Trace link chip only for degraded running sim links", () => {
    expect(showDegradedLinkChip(true, "sim", "connecting")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "reconnecting")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "error")).toBe(true);
    expect(showDegradedLinkChip(true, "sim", "connected")).toBe(false);
    expect(showDegradedLinkChip(true, "sim", "closed")).toBe(false);
    expect(showDegradedLinkChip(true, "devgen", "reconnecting")).toBe(false);
    expect(showDegradedLinkChip(false, "sim", "reconnecting")).toBe(false);
    expect(showDegradedLinkChip(true, "sim", null)).toBe(false);
  });

  it("maps link chip labels, source labels, and token color vars", () => {
    expect(linkChipLabel("connected")).toBe("Connected");
    expect(linkChipLabel("reconnecting")).toBe("Reconnecting");
    expect(linkChipColorVar("connected")).toBe("var(--success)");
    expect(linkChipColorVar("error")).toBe("var(--error)");
    expect(linkChipColorVar("connecting")).toBe("var(--warning)");
    expect(linkChipColorVar("closed")).toBe("var(--text-secondary)");
    expect(sourceKindLabel("devgen")).toBe("Dev generator");
    expect(sourceKindLabel("sim")).toBe("Simulator link");
  });

  it("labels the capture button from source kind", () => {
    expect(captureButtonLabel(false, "devgen")).toContain("dev generator");
    expect(captureButtonLabel(false, "sim")).toContain("simulator");
    expect(captureButtonLabel(true, "sim")).toBe("Stop capture");
  });
});
