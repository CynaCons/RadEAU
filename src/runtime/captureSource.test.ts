import { describe, expect, it } from "vitest";

import {
  buildCaptureSource,
  captureButtonLabel,
  DEFAULT_SIM_ADDR,
  linkChipColorVar,
  linkChipLabel,
  showLinkStatusChip,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
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

  it("gates sim availability and control enablement", () => {
    expect(simSourceAvailable(true)).toBe(true);
    expect(simSourceAvailable(false)).toBe(false);
    expect(sourceControlsDisabled(false)).toBe(false);
    expect(sourceControlsDisabled(true)).toBe(true);
    expect(showSimAddressField("sim")).toBe(true);
    expect(showSimAddressField("devgen")).toBe(false);
    expect(showLinkStatusChip("sim")).toBe(true);
    expect(showLinkStatusChip("devgen")).toBe(false);
  });

  it("maps link chip labels and token color vars", () => {
    expect(linkChipLabel("connected")).toBe("Connected");
    expect(linkChipLabel("reconnecting")).toBe("Reconnecting");
    expect(linkChipColorVar("connected")).toBe("var(--success)");
    expect(linkChipColorVar("error")).toBe("var(--error)");
    expect(linkChipColorVar("connecting")).toBe("var(--warning)");
    expect(linkChipColorVar("closed")).toBe("var(--text-secondary)");
  });

  it("labels the capture button from source kind", () => {
    expect(captureButtonLabel(false, "devgen")).toContain("dev generator");
    expect(captureButtonLabel(false, "sim")).toContain("simulator");
    expect(captureButtonLabel(true, "sim")).toBe("Stop capture");
  });
});
