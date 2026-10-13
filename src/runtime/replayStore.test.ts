import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  positionCb: null as ((p: unknown) => void) | null,
  seekCb: null as ((s: unknown) => void) | null,
  openedCb: null as ((s: unknown) => void) | null,
}));

vi.mock("./desktop", () => ({
  replayOpen: vi.fn(async (path: string) => ({
    path,
    frames: 42,
    firstTsNs: 1_000,
    lastTsNs: 987_655_000_000,
    durationNs: 987_654_000_000,
    interfaces: ["pcap"],
    comment: "fixture replay",
    cut: false,
  })),
  replayPlay: vi.fn(async () => {}),
  replayPause: vi.fn(async () => {}),
  replayStep: vi.fn(async () => {}),
  replaySeek: vi.fn(async () => {}),
  replaySetSpeed: vi.fn(async () => {}),
  onReplayPosition: vi.fn((cb: (p: unknown) => void) => {
    desktopState.positionCb = cb;
    return () => {
      desktopState.positionCb = null;
    };
  }),
  onReplaySeek: vi.fn((cb: (s: unknown) => void) => {
    desktopState.seekCb = cb;
    return () => {
      desktopState.seekCb = null;
    };
  }),
  onReplayOpened: vi.fn((cb: (s: unknown) => void) => {
    desktopState.openedCb = cb;
    return () => {
      desktopState.openedCb = null;
    };
  }),
  startCapture: vi.fn(async () => true),
  stopCapture: vi.fn(async () => {}),
  onCaptureSession: vi.fn(() => () => {}),
  onCaptureLink: vi.fn(() => () => {}),
  onCaptureStats: vi.fn(() => () => {}),
  onCaptureState: vi.fn(() => () => {}),
  appInfo: vi.fn(async () => ({
    version: "0.1.0",
    buildProfile: "browser",
    os: "test",
    devgenAvailable: true,
  })),
  dependencyProbe: vi.fn(async () => []),
}));

import { replayPause, replayPlay, replaySeek, replaySetSpeed, replayStep } from "./desktop";
import { ReplayStore } from "./replayStore";
import { sessionStore } from "./sessionStore";
import { traceStore } from "./traceStore";

describe("ReplayStore", () => {
  let store: ReplayStore;

  beforeEach(() => {
    vi.clearAllMocks();
    traceStore.clear();
    sessionStore.setSourceKind("devgen");
    store = new ReplayStore();
  });

  it("opens a file via replay_open and configures the pcap source (CP-020)", async () => {
    const info = await store.open("C:\\trace\\fixture.pcapng");
    expect(info.frames).toBe(42);
    expect(store.getSnapshot().info?.comment).toBe("fixture replay");
    expect(store.getSnapshot().position?.durationNs).toBe(987_654_000_000);
    expect(sessionStore.getSnapshot().sourceKind).toBe("pcap");
    expect(sessionStore.getSnapshot().pcapPath).toBe("C:\\trace\\fixture.pcapng");
  });

  it("starts the replay session on play when stopped, and surfaces failures (CP-021)", async () => {
    const start = vi.spyOn(sessionStore, "start").mockResolvedValue();
    await store.play();
    expect(start).toHaveBeenCalledTimes(1);
    expect(replayPlay).not.toHaveBeenCalled();
    start.mockRestore();
    vi.mocked(replayPause).mockRejectedValueOnce(new Error("no replay session"));
    await store.pause();
    expect(store.getSnapshot().error).toBe("no replay session");
  });

  it("delegates replay controls to desktop commands (CP-021/VU-028)", async () => {
    const running = vi
      .spyOn(sessionStore, "getSnapshot")
      .mockReturnValue({ ...sessionStore.getSnapshot(), running: true });
    await store.play();
    running.mockRestore();
    await store.pause();
    await store.step();
    await store.seek(123);
    await store.setSpeed(null);

    expect(replayPlay).toHaveBeenCalledTimes(1);
    expect(replayPause).toHaveBeenCalledTimes(1);
    expect(replayStep).toHaveBeenCalledTimes(1);
    expect(replaySeek).toHaveBeenCalledWith(123);
    expect(replaySetSpeed).toHaveBeenCalledWith(null);
  });

  it("reacts to replay:position and clears trace on replay:seek (CP-022)", () => {
    const clear = vi.spyOn(traceStore, "clear");
    desktopState.positionCb?.({
      state: "playing",
      tNs: 12_345_000_000,
      frame: 7,
      frames: 42,
      durationNs: 987_654_000_000,
      speed: 2,
    });
    expect(store.getSnapshot().position?.tNs).toBe(12_345_000_000);

    desktopState.seekCb?.({ tNs: 500, frame: 2 });
    expect(clear).toHaveBeenCalled();
  });

  it("AU-003 mirrors agent replay:opened into replay state and the pcap source", () => {
    desktopState.openedCb?.({
      path: "C:\\agent\\opened.pcapng",
      frames: 7,
      firstTsNs: 100,
      lastTsNs: 2_100,
      durationNs: 2_000,
      interfaces: ["pcap"],
      comment: "agent opened",
      cut: false,
    });

    expect(store.getSnapshot().info?.path).toBe("C:\\agent\\opened.pcapng");
    expect(store.getSnapshot().position).toMatchObject({
      state: "paused",
      tNs: 0,
      frame: 0,
      frames: 7,
      durationNs: 2_000,
      speed: 1,
    });
    expect(sessionStore.getSnapshot().sourceKind).toBe("pcap");
    expect(sessionStore.getSnapshot().pcapPath).toBe("C:\\agent\\opened.pcapng");
  });
});
