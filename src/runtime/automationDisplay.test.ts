import { describe, expect, it } from "vitest";

import { AUTOMATION_EMPTY } from "./automationDisplay";

/** Former fabricated script / console strings that must never reappear. */
const FABRICATED = [
  "sd_monitor_soak.py",
  "fusion_latency_report.py",
  "camera_dropout_probe.py",
  "replay_regression.py",
  "ptp_offset_export.py",
  "RadEAU automation API",
  "session open: fusion-baseline",
];

describe("automationDisplay honesty", () => {
  it("uses the pinned empty-state copy", () => {
    expect(AUTOMATION_EMPTY).toBe("no scripts — automation surface arrives v0.7");
  });

  it("never embeds fabricated script names or console output", () => {
    for (const bad of FABRICATED) {
      expect(AUTOMATION_EMPTY.includes(bad), `fabricated string leaked: ${bad}`).toBe(
        false,
      );
    }
  });
});
