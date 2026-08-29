import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  sessionCb: null as ((s: unknown) => void) | null,
  linkCb: null as ((s: unknown) => void) | null,
  statsCb: null as ((s: unknown) => void) | null,
  mirrorRunning: false,
}));

vi.mock("./desktop", () => ({
  startCapture: vi.fn(async (source: { kind: string; addr?: string }) => {
    if (source.kind === "sim") {
      throw new Error("simulator link is desktop-app only");
    }
    desktopState.mirrorRunning = true;
    desktopState.sessionCb?.({
      sourceKind: "devgen",
      scenario: null,
      endpoints: [{ name: "10.42.0.11", ip: "10.42.0.11" }],
    });
    desktopState.linkCb?.({ state: "connected", detail: null });
    return true;
  }),
  stopCapture: vi.fn(async () => {
    desktopState.mirrorRunning = false;
    desktopState.linkCb?.({ state: "closed", detail: null });
  }),
  onCaptureSession: vi.fn((cb: (s: unknown) => void) => {
    desktopState.sessionCb = cb;
    return () => {
      desktopState.sessionCb = null;
    };
  }),
  onCaptureLink: vi.fn((cb: (s: unknown) => void) => {
    desktopState.linkCb = cb;
    return () => {
      desktopState.linkCb = null;
    };
  }),
  onCaptureStats: vi.fn((cb: (s: unknown) => void) => {
    desktopState.statsCb = cb;
    return () => {
      desktopState.statsCb = null;
    };
  }),
}));

import { SessionStore } from "./sessionStore";
import { startCapture, stopCapture } from "./desktop";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SessionStore();
  });

  afterEach(async () => {
    if (store.getSnapshot().running) await store.stop();
  });

  it("starts stopped with the default devgen source", () => {
    const snap = store.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.sourceKind).toBe("devgen");
    expect(snap.linkStatus).toBeNull();
    expect(snap.sessionInfo).toBeNull();
    expect(snap.stats).toBeNull();
    expect(snap.lastError).toBeNull();
  });

  it("is the sole caller of startCapture / stopCapture on toggle", async () => {
    await store.start();
    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(startCapture).toHaveBeenCalledWith({ kind: "devgen", profile: "normal" });
    expect(store.getSnapshot().running).toBe(true);
    expect(store.getSnapshot().sessionInfo?.sourceKind).toBe("devgen");
    expect(store.getSnapshot().linkStatus?.state).toBe("connected");

    await store.stop();
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().running).toBe(false);
    expect(store.getSnapshot().linkStatus).toBeNull();
  });

  it("locks source edits while running and unlocks when stopped", async () => {
    await store.start();
    store.setSourceKind("sim");
    expect(store.getSnapshot().sourceKind).toBe("devgen");
    store.setSimAddr("10.0.0.1:5560");
    expect(store.getSnapshot().simAddr).toBe("127.0.0.1:5560");

    await store.stop();
    store.setSourceKind("sim");
    store.setSimAddr("10.0.0.1:5560");
    expect(store.getSnapshot().sourceKind).toBe("sim");
    expect(store.getSnapshot().simAddr).toBe("10.0.0.1:5560");
  });

  it("rejects a failed start, stays stopped, and keeps lastError", async () => {
    store.setSourceKind("sim");
    await store.start();
    expect(store.getSnapshot().running).toBe(false);
    expect(store.getSnapshot().linkStatus).toBeNull();
    expect(store.getSnapshot().lastError).toBe("simulator link is desktop-app only");
    expect(stopCapture).not.toHaveBeenCalled();
  });

  it("clears lastError on the next start / stop", async () => {
    store.setSourceKind("sim");
    await store.start();
    expect(store.getSnapshot().lastError).toBeTruthy();

    store.setSourceKind("devgen");
    await store.start();
    expect(store.getSnapshot().lastError).toBeNull();
    expect(store.getSnapshot().running).toBe(true);

    // Inject a fake error while stopped via a failed sim start again after stop.
    await store.stop();
    store.setSourceKind("sim");
    await store.start();
    expect(store.getSnapshot().lastError).toBeTruthy();
    await store.stop(); // stop while not running is a no-op; start failed so not running
    // Clearing: a successful path — switch to devgen and start then stop.
    store.setSourceKind("devgen");
    await store.start();
    expect(store.getSnapshot().lastError).toBeNull();
    await store.stop();
    expect(store.getSnapshot().lastError).toBeNull();
  });

  it("resets stats on start and retains them after stop", async () => {
    await store.start();
    desktopState.statsCb?.({
      seq: 1,
      elapsedS: 1,
      received: 10,
      emitted: 10,
      accumulatorDropped: 0,
      gapRecords: 0,
      gapDropped: 0,
      malformed: 0,
      kernelDropped: 0,
      byClass: new Array(12).fill(0),
    });
    expect(store.getSnapshot().stats?.received).toBe(10);

    await store.stop();
    expect(store.getSnapshot().stats?.received).toBe(10); // retained

    await store.start();
    expect(store.getSnapshot().stats).toBeNull(); // reset
  });

  it("toggle start then stop mirrors the top-bar / rail contract", async () => {
    await store.toggle();
    expect(store.getSnapshot().running).toBe(true);
    await store.toggle();
    expect(store.getSnapshot().running).toBe(false);
  });

  it("notifies subscribers on run-gate transitions", async () => {
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().running));
    await store.start();
    await store.stop();
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});
