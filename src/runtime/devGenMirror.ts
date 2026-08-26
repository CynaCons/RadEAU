/**
 * Browser-mode mirror of the Rust dev frame generator (PRD §3.8): same traffic
 * model, rate profiles, and columnar batch shape as `src-tauri/src/devgen.rs`,
 * so the UI streams identical data in a plain browser with no native build.
 * Seeded and deterministic per environment (the PRNG differs from the Rust
 * xorshift64* by design — determinism is per-environment, not cross-language).
 */

import {
  FrameBatchRaw,
  MSG_EVENT,
  MSG_OFFER,
  MSG_SYNC,
  PROTO_GPTP,
  PROTO_SD,
  PROTO_SOMEIP,
} from "./frameModel";

export type RateProfile = "idle" | "normal" | "stress" | "burst";

/** Instantaneous target fps; deterministic function of elapsed session time. */
export function profileRateAt(profile: RateProfile, elapsedS: number): number {
  switch (profile) {
    case "idle":
      return 50;
    case "normal":
      return 800;
    case "stress":
      return 5000;
    case "burst":
      return elapsedS % 3 < 0.2 ? 5000 : 250;
  }
}

interface ServiceSpec {
  svc: number;
  method: number;
  srcEp: number;
  baseLen: number;
  tx: boolean;
}

const SERVICES: readonly ServiceSpec[] = [
  { svc: 0x1101, method: 0x8001, srcEp: 0, baseLen: 128, tx: false },
  { svc: 0x1102, method: 0x8001, srcEp: 1, baseLen: 96, tx: false },
  { svc: 0x1103, method: 0x8001, srcEp: 2, baseLen: 160, tx: false },
  { svc: 0x1104, method: 0x8001, srcEp: 3, baseLen: 48, tx: false },
  { svc: 0x1201, method: 0x8001, srcEp: 4, baseLen: 144, tx: true },
];

const SNAP_LEN = 12;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MirrorRow {
  idx: number;
  tS: number;
  rx: boolean;
  srcEp: number;
  proto: number;
  svc: number;
  method: number;
  msgType: number;
  session: number;
  wireLen: number;
}

export class DevGenMirror {
  private rng: () => number;
  private idx = 0;
  private tS = 0;
  private sessions = [0, 0, 0, 0, 0];
  private sdCycle = 0;

  constructor(seed = 0x5eed2026) {
    this.rng = mulberry32(seed);
  }

  genFrames(n: number, rate: number): MirrorRow[] {
    const out: MirrorRow[] = [];
    for (let j = 0; j < n; j += 1) {
      this.tS += (1 / rate) * (0.5 + Math.floor(this.rng() * 1000) / 1000);
      out.push(this.genOne());
    }
    return out;
  }

  private randByte(): number {
    return Math.floor(this.rng() * 256);
  }

  private snap(): number[] {
    const bytes: number[] = [];
    for (let j = 0; j < SNAP_LEN; j += 1) bytes.push(this.randByte());
    return bytes;
  }

  private genOne(): MirrorRow {
    const roll = Math.floor(this.rng() * 1000);
    if (roll < 40) return this.genSdOffer();
    if (roll < 80) return this.genGptpSync();
    return this.genSomeipEvent();
  }

  private genSomeipEvent(): MirrorRow {
    const k = this.idx % SERVICES.length;
    const s = SERVICES[k];
    const payloadLen = s.baseLen + Math.floor(this.rng() * 4) * 8;
    // Wire length: Eth(14) + IPv4(20) + UDP(8) + payload.
    const wireLen = 42 + payloadLen;
    this.sessions[k] += 1;
    const row: MirrorRow = {
      idx: this.idx,
      tS: this.tS,
      rx: !s.tx,
      srcEp: s.srcEp,
      proto: PROTO_SOMEIP,
      svc: s.svc,
      method: s.method,
      msgType: MSG_EVENT,
      session: this.sessions[k],
      wireLen,
    };
    this.idx += 1;
    this.snap(); // consume RNG to mirror payload generation
    return row;
  }

  private genSdOffer(): MirrorRow {
    const s = SERVICES[this.sdCycle % SERVICES.length];
    this.sdCycle += 1;
    const wireLen = 42 + 36;
    const row: MirrorRow = {
      idx: this.idx,
      tS: this.tS,
      rx: true,
      srcEp: s.srcEp,
      proto: PROTO_SD,
      svc: 0xffff,
      method: 0x8100,
      msgType: MSG_OFFER,
      session: -1,
      wireLen,
    };
    this.idx += 1;
    this.snap();
    return row;
  }

  private genGptpSync(): MirrorRow {
    const wireLen = 14 + 30;
    const row: MirrorRow = {
      idx: this.idx,
      tS: this.tS,
      rx: true,
      srcEp: 0,
      proto: PROTO_GPTP,
      svc: 0,
      method: 0,
      msgType: MSG_SYNC,
      session: -1,
      wireLen,
    };
    this.idx += 1;
    this.snap();
    return row;
  }
}

/** Columnar projection of mirror rows into the single batch event shape. */
export function projectMirrorBatch(seq: number, rows: readonly MirrorRow[]): FrameBatchRaw {
  const batch: FrameBatchRaw = {
    seq,
    i: [],
    t: [],
    d: [],
    s: [],
    p: [],
    sv: [],
    m: [],
    ty: [],
    se: [],
    l: [],
    pb: [],
  };
  for (const r of rows) {
    batch.i.push(r.idx);
    batch.t.push(r.tS);
    batch.d.push(r.rx ? 1 : 0);
    batch.s.push(r.srcEp);
    batch.p.push(r.proto);
    batch.sv.push(r.svc);
    batch.m.push(r.method);
    batch.ty.push(r.msgType);
    batch.se.push(r.session);
    batch.l.push(r.wireLen);
    batch.pb.push(new Array(SNAP_LEN).fill(0));
  }
  return batch;
}
