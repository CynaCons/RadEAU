import { describe, expect, it } from "vitest";

import { DevGenMirror, profileRateAt, projectMirrorBatch } from "./devGenMirror";
import { PROTO_GPTP, PROTO_SD, PROTO_SOMEIP } from "./frameModel";

describe("DevGenMirror", () => {
  it("is deterministic for the same seed", () => {
    const a = new DevGenMirror(1234);
    const b = new DevGenMirror(1234);
    const ra = a.genFrames(500, 800);
    const rb = b.genFrames(500, 800);
    expect(ra).toEqual(rb);
  });

  it("produces all three protocol classes within a few hundred frames", () => {
    const gen = new DevGenMirror(7);
    const rows = gen.genFrames(300, 800);
    const protos = new Set(rows.map((r) => r.proto));
    expect(protos.has(PROTO_SOMEIP)).toBe(true);
    expect(protos.has(PROTO_SD)).toBe(true);
    expect(protos.has(PROTO_GPTP)).toBe(true);
  });

  it("advances synthetic time by ~1/rate per frame", () => {
    const gen = new DevGenMirror(99);
    gen.genFrames(800, 800); // ~1 s of synthetic traffic
    const t = (gen as unknown as { tS: number }).tS;
    expect(t).toBeGreaterThan(0.9);
    expect(t).toBeLessThan(1.1);
  });

  it("keeps wire lengths within Ethernet bounds and sessions monotonic", () => {
    const gen = new DevGenMirror(5);
    const rows = gen.genFrames(400, 5000);
    for (const r of rows) {
      expect(r.wireLen).toBeGreaterThanOrEqual(14);
      expect(r.wireLen).toBeLessThanOrEqual(1522);
      if (r.proto === PROTO_SOMEIP) {
        // L3 frames: 42-byte overhead + payload ≥ 48.
        expect(r.wireLen).toBeGreaterThanOrEqual(90);
      }
    }
    const fused = rows.filter((r) => r.svc === 0x1201 && r.session >= 0);
    for (let j = 1; j < fused.length; j += 1) {
      expect(fused[j].session).toBe(fused[j - 1].session + 1);
    }
  });
});

describe("profileRateAt", () => {
  it("matches the contract rates", () => {
    expect(profileRateAt("idle", 0)).toBe(50);
    expect(profileRateAt("normal", 0)).toBe(800);
    expect(profileRateAt("stress", 9.9)).toBe(5000);
    expect(profileRateAt("burst", 2.9)).toBe(250);
    expect(profileRateAt("burst", 3.05)).toBe(5000);
  });
});

describe("projectMirrorBatch", () => {
  it("keeps all columns parallel with the row count", () => {
    const gen = new DevGenMirror(11);
    const rows = gen.genFrames(50, 800);
    const batch = projectMirrorBatch(4, rows);
    expect(batch.seq).toBe(4);
    for (const key of ["i", "t", "d", "s", "p", "sv", "m", "ty", "se", "l"] as const) {
      expect(batch[key]).toHaveLength(50);
    }
    expect(batch.pb).toHaveLength(50);
    expect(batch.i[0]).toBe(rows[0].idx);
    expect(batch.t[49]).toBeCloseTo(rows[49].tS, 10);
  });
});
