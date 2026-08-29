/**
 * Live ingestion store for the Trace view: bounded ring (200,000 rows,
 * SRS_streaming.md §7), adaptive flush (50 ms when batches ≥ 64 frames, else
 * 100 ms — an interval timer, not rAF), swap-don't-copy pending buffers, and
 * pause staging with a real buffered count.
 */

import {
  FrameBatchRaw,
  projectRow,
  TraceFrame,
} from "./frameModel";

export const TRACE_RING_CAP = 200_000;
const PAUSED_STAGING_CAP = 20_000;
const ADAPTIVE_FLUSH_THRESHOLD = 64;
const FLUSH_FAST_MS = 50;
const FLUSH_SLOW_MS = 100;

export interface TraceSnapshot {
  /** Rows in ring order; identity changes only when the row set changes. */
  readonly rows: readonly TraceFrame[];
  readonly pausedBuffered: number;
}

export class TraceStore {
  private ring: (TraceFrame | null)[];
  private head = 0; // next write slot
  private rowCount = 0;
  private rowsView: readonly TraceFrame[] = [];

  private pending: FrameBatchRaw[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBatchLen = 0;

  private prevT: number | null = null;
  private lastByKey = new Map<string, number>();

  private paused = false;
  private staged: (TraceFrame | null)[];
  private stagedHead = 0; // next write slot
  private stagedCount = 0;
  pausedBuffered = 0;

  private listeners = new Set<() => void>();
  private snapshot: TraceSnapshot = { rows: [], pausedBuffered: 0 };

  constructor(
    capacity: number = TRACE_RING_CAP,
    stagingCapacity: number = PAUSED_STAGING_CAP,
  ) {
    this.ring = new Array<TraceFrame | null>(capacity).fill(null);
    this.staged = new Array<TraceFrame | null>(stagingCapacity).fill(null);
    this.publish();
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): TraceSnapshot => this.snapshot;

  /** Accepts one batched event; schedules the adaptive flush. */
  ingest(batch: FrameBatchRaw): void {
    this.lastBatchLen = batch.i.length;
    this.pending.push(batch);
    if (this.flushTimer === null) {
      const delay =
        this.lastBatchLen >= ADAPTIVE_FLUSH_THRESHOLD ? FLUSH_FAST_MS : FLUSH_SLOW_MS;
      this.flushTimer = setTimeout(this.flush, delay);
    }
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) {
      // Resume: merge the staged buffer into the ring, oldest first.
      const drained: TraceFrame[] = new Array(this.stagedCount);
      const cap = this.staged.length;
      const start = this.stagedCount < cap ? 0 : this.stagedHead;
      for (let j = 0; j < this.stagedCount; j += 1) {
        drained[j] = this.staged[(start + j) % cap] as TraceFrame;
      }
      this.staged.fill(null);
      this.stagedHead = 0;
      this.stagedCount = 0;
      this.pausedBuffered = 0;
      this.appendRows(drained);
    } else {
      this.publish();
    }
  }

  clear(): void {
    this.ring.fill(null);
    this.head = 0;
    this.rowCount = 0;
    this.rowsView = [];
    this.pending = [];
    this.staged.fill(null);
    this.stagedHead = 0;
    this.stagedCount = 0;
    this.pausedBuffered = 0;
    this.prevT = null;
    this.lastByKey.clear();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.publish();
  }

  dispose(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.listeners.clear();
  }

  private publish(): void {
    this.snapshot = { rows: this.rowsView, pausedBuffered: this.pausedBuffered };
    for (const cb of this.listeners) cb();
  }

  private flush = (): void => {
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];

    const decoded: TraceFrame[] = [];
    let prev = this.prevT;
    for (const batch of pending) {
      for (let k = 0; k < batch.i.length; k += 1) {
        const row = projectRow(batch, k, prev, this.lastByKey);
        decoded.push(row);
        const t = batch.t[k];
        this.lastByKey.set(row.key, t);
        prev = t;
      }
    }
    this.prevT = prev;

    if (this.paused) {
      const cap = this.staged.length;
      for (const row of decoded) {
        if (this.stagedCount >= cap) {
          this.staged[this.stagedHead] = null;
        } else {
          this.stagedCount += 1;
        }
        this.staged[this.stagedHead] = row; // overwrite oldest when full
        this.stagedHead = (this.stagedHead + 1) % cap;
      }
      this.pausedBuffered = this.stagedCount;
      this.publish();
      return;
    }
    this.appendRows(decoded);
  };

  /** Appends rows to the ring, evicting oldest; rebuilds the view array. */
  private appendRows(rows: readonly TraceFrame[]): void {
    const cap = this.ring.length;
    for (const row of rows) {
      this.ring[this.head] = row;
      this.head = (this.head + 1) % cap;
      if (this.rowCount < cap) this.rowCount += 1;
    }
    const view: TraceFrame[] = new Array(this.rowCount);
    const start = this.rowCount < cap ? 0 : this.head;
    for (let j = 0; j < this.rowCount; j += 1) {
      view[j] = this.ring[(start + j) % cap] as TraceFrame;
    }
    this.rowsView = view;
    this.publish();
  }
}

/** Application-wide trace store singleton. */
export const traceStore = new TraceStore();
