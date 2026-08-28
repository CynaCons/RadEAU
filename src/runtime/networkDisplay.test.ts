import { describe, expect, it } from "vitest";

import {
  connectionPanelModel,
  NETWORK_EMPTY,
  SESSION_STOPPED_HINT,
} from "./networkDisplay";

/** Strings that must never appear — leftovers from the fabricated Network mock. */
const FABRICATED = [
  "CameraECU",
  "RadarECU",
  "LidarECU",
  "FusionECU",
  "GatewayECU",
  "DynamicsECU",
  "RX 12480",
  "TX 3214",
  "sensor-fusion",
  "10.42.0.11",
  "UDP 30490",
];

describe("networkDisplay Connection panel", () => {
  it("reports stopped session truth with the Start hint", () => {
    const model = connectionPanelModel({
      running: false,
      sourceKind: "devgen",
      simAddr: "127.0.0.1:5560",
      linkStatus: null,
      sessionInfo: null,
    });
    expect(model.sourceLabel).toBe("Dev generator");
    expect(model.address).toBeNull();
    expect(model.running).toBe(false);
    expect(model.sessionChipLabel).toBe("Session stopped");
    expect(model.linkChipLabel).toBeNull();
    expect(model.stoppedHint).toBe(SESSION_STOPPED_HINT);
    expect(model.stoppedHint).toMatch(/press Start/i);
  });

  it("reports running sim source, address, scenario, and Connected link", () => {
    const model = connectionPanelModel({
      running: true,
      sourceKind: "sim",
      simAddr: "127.0.0.1:15560",
      linkStatus: { state: "connected", detail: null },
      sessionInfo: {
        sourceKind: "sim",
        scenario: "demo-lane",
        endpoints: [],
      },
    });
    expect(model.sourceLabel).toBe("Simulator link");
    expect(model.address).toBe("127.0.0.1:15560");
    expect(model.scenario).toBe("demo-lane");
    expect(model.sessionChipLabel).toBe("Session running");
    expect(model.linkChipLabel).toBe("Connected");
    expect(model.linkState).toBe("connected");
    expect(model.stoppedHint).toBeNull();
  });

  it("keeps empty-state copy honest and free of fabricated ECU/counter strings", () => {
    const corpus = [
      ...Object.values(NETWORK_EMPTY),
      SESSION_STOPPED_HINT,
      JSON.stringify(
        connectionPanelModel({
          running: true,
          sourceKind: "sim",
          simAddr: "127.0.0.1:5560",
          linkStatus: { state: "reconnecting", detail: "backoff" },
          sessionInfo: null,
        }),
      ),
    ].join("\n");
    for (const bad of FABRICATED) {
      expect(corpus.includes(bad), `fabricated string leaked: ${bad}`).toBe(false);
    }
    expect(NETWORK_EMPTY.externalNodes).toBe("no external nodes attached");
    expect(NETWORK_EMPTY.automation).toMatch(/v0\.7/);
    expect(NETWORK_EMPTY.topology).toMatch(/v0\.5/);
    expect(NETWORK_EMPTY.sdMonitor).toMatch(/SD traffic/);
    expect(NETWORK_EMPTY.ptp).toMatch(/PTP/);
  });
});
