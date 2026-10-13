import { describe, expect, it } from "vitest";

import { DevGenMirror, profileRateAt, projectMirrorBatch } from "./devGenMirror";
import {
  DIR_RX,
  DIR_TX,
  GPTP_TY_SYNC,
  PROTO_GPTP,
  PROTO_SD,
  PROTO_SOMEIP,
  SD_TY_OFFER,
  SOMEIP_TY_NOTIFICATION,
} from "./wireCodes";

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
        expect(r.wireLen).toBeGreaterThanOrEqual(90);
      }
    }
    const fused = rows.filter((r) => r.svc === 0x1201 && r.session >= 0);
    for (let j = 1; j < fused.length; j += 1) {
      expect(fused[j]!.session).toBe(fused[j - 1]!.session + 1);
    }
  });

  it("emits the new wire columns and code tables", () => {
    const gen = new DevGenMirror(3);
    const rows = gen.genFrames(200, 800);
    for (const r of rows) {
      expect(r.vl).toBe(-1);
      expect(r.sm).toBeGreaterThan(0);
      if (r.proto === PROTO_SOMEIP) {
        expect(r.msgType).toBe(SOMEIP_TY_NOTIFICATION);
        expect(r.po).toBe(42);
        expect(r.sa).toBeGreaterThan(0);
        expect(r.da).toBeGreaterThan(0);
      } else if (r.proto === PROTO_SD) {
        expect(r.msgType).toBe(SD_TY_OFFER);
        expect(r.po).toBe(42);
        expect(r.sa).toBeGreaterThan(0);
      } else if (r.proto === PROTO_GPTP) {
        expect(r.msgType).toBe(GPTP_TY_SYNC);
        expect(r.po).toBe(14);
        expect(r.sa).toBe(0);
      }
    }
    const tx = rows.filter((r) => !r.rx);
    const rx = rows.filter((r) => r.rx);
    expect(tx.length).toBeGreaterThan(0);
    expect(rx.length).toBeGreaterThan(0);
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
    for (const key of [
      "i",
      "t",
      "d",
      "s",
      "p",
      "sv",
      "m",
      "ty",
      "se",
      "l",
      "sa",
      "da",
      "sm",
      "vl",
      "po",
    ] as const) {
      expect(batch[key]).toHaveLength(50);
    }
    expect(batch.pb).toHaveLength(50);
    expect(batch.i[0]).toBe(rows[0]!.idx);
    expect(batch.t[49]).toBeCloseTo(rows[49]!.tS, 10);
    expect(batch.d.every((d) => d === DIR_RX || d === DIR_TX)).toBe(true);
    expect(batch.ty.some((t, i) => rows[i]!.proto === PROTO_SOMEIP && t === SOMEIP_TY_NOTIFICATION)).toBe(
      true,
    );
    expect(batch.po.some((po, i) => rows[i]!.proto === PROTO_GPTP && po === 14)).toBe(true);
  });
});
