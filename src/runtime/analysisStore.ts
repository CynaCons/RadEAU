/** AN-008: the Network view's analysis snapshot (run on demand, kept until the next run). */
import {
  traceAnalyze,
  type AnalysisFrom,
  type AnalysisReport,
  type AnalysisSections,
} from "./desktop";

export interface AnalysisSnapshot {
  readonly running: boolean;
  readonly result: AnalysisReport | null;
  readonly error: string | null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export class AnalysisStore {
  private running = false;
  private result: AnalysisReport | null = null;
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: AnalysisSnapshot = this.buildSnapshot();
  private runSeq = 0;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): AnalysisSnapshot => this.snapshot;

  async run(
    from: AnalysisFrom = { kind: "ring" },
    sections?: AnalysisSections,
  ): Promise<void> {
    if (this.running) return;
    const seq = ++this.runSeq;
    this.running = true;
    this.result = null;
    this.error = null;
    this.publish();
    try {
      const result = await traceAnalyze(from, sections);
      if (seq !== this.runSeq) return;
      this.result = result;
      this.error = null;
    } catch (err) {
      if (seq !== this.runSeq) return;
      this.error = errMessage(err);
    } finally {
      if (seq === this.runSeq) {
        this.running = false;
        this.publish();
      }
    }
  }

  applyResultForTest(result: AnalysisReport | null): void {
    this.running = false;
    this.result = result;
    this.error = null;
    this.runSeq += 1;
    this.publish();
  }

  resetForTest(): void {
    this.running = false;
    this.result = null;
    this.error = null;
    this.runSeq += 1;
    this.publish();
  }

  private buildSnapshot(): AnalysisSnapshot {
    return {
      running: this.running,
      result: this.result,
      error: this.error,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }
}

export const analysisStore = new AnalysisStore();
