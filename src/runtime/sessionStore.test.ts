import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "./sessionStore";

vi.mock("./desktop", () => {
  let sessionCb: ((s: unknown) => void) | null = null;
  let linkCb: ((s: unknown) => void) | null = null;
  let mirrorRunning = false;

  return {
    startCapture: vi.fn(async (source: { kind: string; addr?: string }) => {
      if (source.kind === "sim") {
        throw new Error("simulator link is desktop-app only");
      }
      mirrorRunning = true;
      sessionCb?.({
        sourceKind: "devgen",
        scenario: null,
        endpoints: [{ name: "10.42.0.11", ip: "10.42.0.11" }],
      });
      linkCb?.({ state: "connected", detail: null });
      return true;
    }),
    stopCapture: vi.fn(async () => {
      mirrorRunning = false;
      linkCb?.({ state: "closed", detail: null });
    }),
    onCaptureSession: vi.fn((cb: (s: unknown) => void) => {
      sessionCb = cb;
      return () => {
        sessionCb = null;
      };
    }),
    onCaptureLink: vi.fn((cb: (s: unknown) => void) => {
      linkCb = cb;
      return () => {
        linkCb = null;
      };
    }),
    __isMirrorRunning: () => mirrorRunning,
  };
});

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

  it("rejects a failed start and stays stopped (browser sim)", async () => {
    store.setSourceKind("sim");
    await store.start();
    expect(store.getSnapshot().running).toBe(false);
    expect(store.getSnapshot().linkStatus).toBeNull();
    expect(stopCapture).not.toHaveBeenCalled();
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
