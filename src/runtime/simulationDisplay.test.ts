import { describe, expect, it } from "vitest";

import { SIM_EMPTY } from "./simulationDisplay";

/** Former mock signal names that must never reappear as live-looking UI. */
const FABRICATED_SIGNALS = ["VehicleSpeed", "YawRate", "ObjectCount"];

describe("simulationDisplay honesty", () => {
  it("names v0.7 for every secondary-rail entry", () => {
    expect(SIM_EMPTY.node).toBe("node simulation arrives v0.7");
    expect(SIM_EMPTY.signal).toBe("signal simulation arrives v0.7");
    expect(SIM_EMPTY["frame-gen"]).toBe("frame generation arrives v0.7");
    expect(SIM_EMPTY.presets).toBe("presets arrive v0.7");
  });

  it("never embeds fabricated signal names", () => {
    const corpus = Object.values(SIM_EMPTY).join("\n");
    for (const bad of FABRICATED_SIGNALS) {
      expect(corpus.includes(bad), `fabricated signal leaked: ${bad}`).toBe(false);
    }
  });
});
