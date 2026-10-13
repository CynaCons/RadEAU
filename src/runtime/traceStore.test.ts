import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FrameBatchRaw } from "./frameModel";
import { TraceStore } from "./traceStore";
import {
  DIR_RX,
  PROTO_GPTP,
  PROTO_SD,
  PROTO_SOMEIP,
  SD_TY_OFFER,
  SOMEIP_TY_NOTIFICATION,
} from "./wireCodes";

function makeBatch(
  seq: number,
  rows: Array<{
    idx: number;
    t: number;
    d?: number;
    s?: number;
    p?: number;
    sv?: number;
    m?: number;
    ty?: number;
    se?: number;
    l?: number;
    sa?: number;
    da?: number;
    sm?: number;
    vl?: number;
    po?: number;
  }>,
): FrameBatchRaw {
  return {
    seq,
    i: rows.map((r) => r.idx),
    t: rows.map((r) => r.t),
    d: rows.map((r) => r.d ?? DIR_RX),
    s: rows.map((r) => r.s ?? 0),
    p: rows.map((r) => r.p ?? PROTO_SOMEIP),
    sv: rows.map((r) => r.sv ?? 0x1101),
    m: rows.map((r) => r.m ?? 0x8001),
    ty: rows.map((r) => r.ty ?? SOMEIP_TY_NOTIFICATION),
    se: rows.map((r) => r.se ?? -1),
    l: rows.map((r) => r.l ?? 100),
    pb: rows.map(() => [0xde, 0xad, 0xbe, 0xef]),
    sa: rows.map((r) => r.sa ?? ((10 << 24) | (42 << 16) | (0 << 8) | (11 + (r.s ?? 0)))),
    da: rows.map((r) => r.da ?? ((10 << 24) | (42 << 16) | (0 << 8) | 20)),
    sm: rows.map((r) => r.sm ?? 0x02004200000b + (r.s ?? 0)),
    vl: rows.map((r) => r.vl ?? -1),
    po: rows.map((r) => r.po ?? (r.p === PROTO_GPTP ? 14 : 42)),
  };
}

describe("TraceStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a small batch on the slow (100 ms) cadence", () => {
    const store = new TraceStore();
    store.ingest(makeBatch(0, [{ idx: 1, t: 0.5 }]));
    expect(store.getSnapshot().rows).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(store.getSnapshot().rows).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().rows).toHaveLength(1);
    store.dispose();
  });

  it("flushes a large batch on the fast (50 ms) cadence", () => {
    const store = new TraceStore();
    const rows = Array.from({ length: 64 }, (_, j) => ({ idx: j, t: j / 1000 }));
    store.ingest(makeBatch(0, rows));
    vi.advanceTimersByTime(49);
    expect(store.getSnapshot().rows).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().rows).toHaveLength(64);
    store.dispose();
  });

  it("projects columnar entries into full rows with deltas", () => {
    const store = new TraceStore();
    store.ingest(
      makeBatch(0, [
        { idx: 1, t: 1.0, sv: 0x1101 },
        { idx: 2, t: 1.25, sv: 0x1102 },
        { idx: 3, t: 1.5, sv: 0x1101 },
        { idx: 4, t: 2.0, p: PROTO_GPTP },
      ]),
    );
    vi.advanceTimersByTime(100);
    const rows = store.getSnapshot().rows;
    expect(rows.get(0).deltaGlobal).toBe("--");
    expect(rows.get(0).deltaKey).toBe("--");
    expect(rows.get(2).deltaGlobal).toBe("0.2500");
    expect(rows.get(2).deltaKey).toBe("0.5000"); // vs the earlier 0x1101 frame
    expect(rows.get(3).protocol).toBe("gPTP");
    expect(rows.get(3).session).toBe("--");
    expect(rows.get(0).payload.startsWith("DE AD BE EF")).toBe(true);
    store.dispose();
  });

  it("wraps the ring and drops oldest past capacity", () => {
    const store = new TraceStore(5);
    const rows = Array.from({ length: 8 }, (_, j) => ({ idx: j + 1, t: j / 10 }));
    store.ingest(makeBatch(0, rows));
    vi.advanceTimersByTime(50); // ≥64? no — 8 rows → slow cadence
    vi.advanceTimersByTime(50);
    const snap = store.getSnapshot();
    expect(snap.rows).toHaveLength(5);
    expect(Array.from({ length: snap.rows.length }, (_, i) => snap.rows.get(i).id)).toEqual([4, 5, 6, 7, 8]);
    store.dispose();
  });

  it("indexes wrapped rows in chronological order", () => {
    const store = new TraceStore(5);
    store.ingest(
      makeBatch(
        0,
        Array.from({ length: 8 }, (_, j) => ({ idx: j + 1, t: j / 10 })),
      ),
    );
    vi.advanceTimersByTime(100);

    const rows = store.getSnapshot().rows;
    expect(Array.from({ length: rows.length }, (_, index) => rows.get(index).id)).toEqual([
      4, 5, 6, 7, 8,
    ]);
    expect(() => rows.get(5)).toThrow(RangeError);
    store.dispose();
  });

  it("publishes a new row-view identity without copying the full ring", () => {
    const store = new TraceStore(5);
    const emptyRows = store.getSnapshot().rows;
    store.ingest(makeBatch(0, [{ idx: 1, t: 0.1 }]));
    vi.advanceTimersByTime(100);
    const firstRows = store.getSnapshot().rows;
    store.ingest(makeBatch(1, [{ idx: 2, t: 0.2 }]));
    vi.advanceTimersByTime(100);
    const secondRows = store.getSnapshot().rows;

    expect(firstRows).not.toBe(emptyRows);
    expect(secondRows).not.toBe(firstRows);
    expect(Array.from({ length: secondRows.length }, (_, i) => secondRows.get(i).id)).toEqual([1, 2]);
    store.dispose();
  });

  it("stages while paused with a live buffered count and merges on resume", () => {
    const store = new TraceStore(100);
    store.setPaused(true);
    store.ingest(makeBatch(0, [{ idx: 1, t: 0.1 }]));
    vi.advanceTimersByTime(100);
    let snap = store.getSnapshot();
    expect(snap.rows).toHaveLength(0);
    expect(snap.pausedBuffered).toBe(1);

    store.ingest(makeBatch(1, [{ idx: 2, t: 0.2 }]));
    vi.advanceTimersByTime(100);
    snap = store.getSnapshot();
    expect(snap.pausedBuffered).toBe(2);

    store.setPaused(false);
    snap = store.getSnapshot();
    expect(snap.rows).toHaveLength(2);
    expect(snap.pausedBuffered).toBe(0);
    expect(Array.from({ length: snap.rows.length }, (_, i) => snap.rows.get(i).id)).toEqual([1, 2]);
    store.dispose();
  });

  it("drops staged oldest when paused staging overflows", () => {
    const store = new TraceStore(1000, 3);
    store.setPaused(true);
    const rows = Array.from({ length: 5 }, (_, j) => ({ idx: j + 1, t: j / 10 }));
    store.ingest(makeBatch(0, rows));
    vi.advanceTimersByTime(100);
    const snap = store.getSnapshot();
    expect(snap.pausedBuffered).toBe(3);
    store.setPaused(false);
    const resumed = store.getSnapshot().rows;
    expect(Array.from({ length: resumed.length }, (_, i) => resumed.get(i).id)).toEqual([3, 4, 5]);
    store.dispose();
  });

  it("clear resets everything including pending batches and deltas", () => {
    const store = new TraceStore();
    store.ingest(makeBatch(0, [{ idx: 1, t: 0.1 }]));
    vi.advanceTimersByTime(100);
    expect(store.getSnapshot().rows).toHaveLength(1);
    store.clear();
    expect(store.getSnapshot().rows).toHaveLength(0);
    // Pending batch scheduled before clear must not resurrect rows.
    store.ingest(makeBatch(1, [{ idx: 2, t: 0.2 }]));
    store.clear();
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot().rows).toHaveLength(0);
    // Deltas restart after clear.
    store.ingest(makeBatch(2, [{ idx: 3, t: 9.9 }, { idx: 4, t: 10.0, sv: 0x1101 }]));
    vi.advanceTimersByTime(100);
    const rows = store.getSnapshot().rows;
    expect(rows.get(0).deltaGlobal).toBe("--");
    expect(rows.get(1).deltaKey).toBe("0.1000");
    store.dispose();
  });

  it("notifies subscribers only when the snapshot changes", () => {
    const store = new TraceStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().rows.length));
    store.ingest(makeBatch(0, [{ idx: 1, t: 0.1 }]));
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1]);
    // Second flush with nothing pending publishes nothing.
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([1]);
    store.dispose();
  });

  it("classifies SD offers through the shared projection", () => {
    const store = new TraceStore();
    store.ingest(
      makeBatch(0, [{ idx: 9, t: 0.42, p: PROTO_SD, sv: 0xffff, m: 0x8100, ty: SD_TY_OFFER }]),
    );
    vi.advanceTimersByTime(100);
    const row = store.getSnapshot().rows.get(0);
    expect(row.protocol).toBe("SD");
    expect(row.serviceMethod).toBe("0xFFFF:0x8100");
    expect(row.type).toBe("Offer");
    expect(row.name.startsWith("Offer ·")).toBe(true);
    store.dispose();
  });

  it("computes per-node cycle time for SD / gPTP keys", () => {
    const store = new TraceStore();
    store.ingest(
      makeBatch(0, [
        { idx: 1, t: 1.0, p: PROTO_SD, s: 0, sv: 0xffff, m: 0x8100, ty: SD_TY_OFFER },
        { idx: 2, t: 1.1, p: PROTO_SD, s: 1, sv: 0xffff, m: 0x8100, ty: SD_TY_OFFER },
        { idx: 3, t: 1.5, p: PROTO_SD, s: 0, sv: 0xffff, m: 0x8100, ty: SD_TY_OFFER },
        { idx: 4, t: 2.0, p: PROTO_GPTP, s: 2 },
        { idx: 5, t: 2.25, p: PROTO_GPTP, s: 2 },
      ]),
    );
    vi.advanceTimersByTime(100);
    const rows = store.getSnapshot().rows;
    expect(rows.get(0).deltaKey).toBe("--");
    expect(rows.get(1).deltaKey).toBe("--"); // different source node
    expect(rows.get(2).deltaKey).toBe("0.5000"); // same SD node as rows[0]
    expect(rows.get(3).deltaKey).toBe("--");
    expect(rows.get(4).deltaKey).toBe("0.2500");
    store.dispose();
  });
});
