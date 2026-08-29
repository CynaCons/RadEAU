import { describe, expect, it } from "vitest";

import { emptyByClass, type CaptureStats } from "./captureSource";
import {
  connectionPanelModel,
  formatClassCounts,
  NETWORK_EMPTY,
  SESSION_STOPPED_HINT,
} from "./networkDisplay";
import {
  PROTO_ARP,
  PROTO_GPTP,
  PROTO_SD,
  PROTO_SOMEIP,
} from "./wireCodes";

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

function makeStats(partial: Partial<CaptureStats> = {}): CaptureStats {
  const byClass = emptyByClass();
  byClass[PROTO_SOMEIP] = 12340;
  byClass[PROTO_SD] = 51;
  byClass[PROTO_GPTP] = 800;
  byClass[PROTO_ARP] = 12;
  return {
    seq: 1,
    elapsedS: 12,
    received: 13203,
    emitted: 13200,
    accumulatorDropped: 2,
    gapRecords: 1,
    gapDropped: 1,
    malformed: 3,
    kernelDropped: 0,
    byClass,
    ...partial,
  };
}

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
    expect(model.stats).toBeNull();
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

  it("exposes capture:stats counters and a non-zero class line", () => {
    const model = connectionPanelModel({
      running: true,
      sourceKind: "sim",
      simAddr: "127.0.0.1:5560",
      linkStatus: { state: "connected", detail: null },
      sessionInfo: null,
      stats: makeStats(),
    });
    expect(model.stats).not.toBeNull();
    expect(model.stats!.received).toBe(13203);
    expect(model.stats!.emitted).toBe(13200);
    expect(model.stats!.dropped).toBe(3); // accumulator 2 + gap 1 + kernel 0
    expect(model.stats!.gaps).toBe(1);
    expect(model.stats!.malformed).toBe(3);
    expect(model.stats!.classLine).toBe("SOME/IP 12,340 · SD 51 · gPTP 800 · ARP 12");
    expect(model.stats!.caption).toBeNull();
  });

  it("captions last session when stopped with stats present", () => {
    const model = connectionPanelModel({
      running: false,
      sourceKind: "devgen",
      simAddr: "127.0.0.1:5560",
      linkStatus: null,
      sessionInfo: null,
      stats: makeStats(),
    });
    expect(model.stats!.caption).toBe("last session");
  });

  it("formats only non-zero classes", () => {
    expect(formatClassCounts(emptyByClass())).toBeNull();
    const byClass = emptyByClass();
    byClass[PROTO_GPTP] = 800;
    expect(formatClassCounts(byClass)).toBe("gPTP 800");
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
