import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  state: {
    armed: false,
    active: false,
    path: null as string | null,
    frames: 0,
    bytes: 0,
    dropped: 0,
    error: null as string | null,
    dir: "browser",
    startedMs: null as number | null,
  },
  list: [] as Array<{
    path: string;
    bytes: number;
    frames: number | null;
    startedMs: number;
  }>,
  stateCb: null as ((s: unknown) => void) | null,
  dirSetReject: null as string | null,
}));

vi.mock("./desktop", () => ({
  recordingState: vi.fn(async () => ({ ...desktopState.state })),
  recordingArm: vi.fn(async (armed: boolean) => {
    desktopState.state = {
      ...desktopState.state,
      armed,
      // Mirror core: arming while "active session" would open a file; tests
      // drive active via onRecordingState.
      active: desktopState.state.active && armed ? desktopState.state.active : false,
      path: armed && desktopState.state.active ? desktopState.state.path : null,
      error: null,
    };
    if (!armed) {
      desktopState.state = {
        ...desktopState.state,
        active: false,
        path: null,
        frames: 0,
        bytes: 0,
        dropped: 0,
        startedMs: null,
      };
    }
    const snap = { ...desktopState.state };
    desktopState.stateCb?.(snap);
    return snap;
  }),
  recordingDirGet: vi.fn(async () => desktopState.state.dir),
  recordingDirSet: vi.fn(async (path: string) => {
    if (desktopState.dirSetReject) {
      throw new Error(desktopState.dirSetReject);
    }
    if (desktopState.state.active) {
      throw new Error("cannot change directory while recording is active");
    }
    desktopState.state = { ...desktopState.state, dir: path };
    return path;
  }),
  recordingList: vi.fn(async () => desktopState.list.slice()),
  onRecordingState: vi.fn((cb: (s: unknown) => void) => {
    desktopState.stateCb = cb;
    return () => {
      desktopState.stateCb = null;
    };
  }),
}));

import { RecordingStore } from "./recordingStore";

describe("RecordingStore", () => {
  let store: RecordingStore;

  beforeEach(() => {
    desktopState.state = {
      armed: false,
      active: false,
      path: null,
      frames: 0,
      bytes: 0,
      dropped: 0,
      error: null,
      dir: "browser",
      startedMs: null,
    };
    desktopState.list = [];
    desktopState.stateCb = null;
    desktopState.dirSetReject = null;
    store = new RecordingStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bootstraps from recording_state and an empty list", async () => {
    await vi.waitFor(() => expect(store.getSnapshot().ready).toBe(true));
    const snap = store.getSnapshot();
    expect(snap.armed).toBe(false);
    expect(snap.active).toBe(false);
    expect(snap.dir).toBe("browser");
    expect(snap.list).toEqual([]);
  });

  it("arm toggles armed via recording_arm", async () => {
    await vi.waitFor(() => expect(store.getSnapshot().ready).toBe(true));
    await store.arm(true);
    expect(store.getSnapshot().armed).toBe(true);
    expect(store.getSnapshot().active).toBe(false);

    await store.arm(false);
    expect(store.getSnapshot().armed).toBe(false);
  });

  it("applies recording:state transitions (active writing → idle list)", async () => {
    await vi.waitFor(() => expect(store.getSnapshot().ready).toBe(true));
    await store.arm(true);

    desktopState.list = [
      {
        path: "C:\\rec\\radeau-1.pcap",
        bytes: 4096,
        frames: 20,
        startedMs: 1,
      },
    ];
    desktopState.stateCb?.({
      armed: true,
      active: true,
      path: "C:\\rec\\radeau-1.pcap",
      frames: 20,
      bytes: 4096,
      dropped: 0,
      error: null,
      dir: "C:\\rec",
      startedMs: 1,
    });
    expect(store.getSnapshot().active).toBe(true);
    expect(store.getSnapshot().frames).toBe(20);
    expect(store.getSnapshot().path).toBe("C:\\rec\\radeau-1.pcap");

    desktopState.stateCb?.({
      armed: true,
      active: false,
      path: null,
      frames: 0,
      bytes: 0,
      dropped: 0,
      error: null,
      dir: "C:\\rec",
      startedMs: null,
    });
    await vi.waitFor(() => expect(store.getSnapshot().list).toHaveLength(1));
    expect(store.getSnapshot().list[0]!.bytes).toBe(4096);
  });

  it("setDir commits and surfaces rejection while active", async () => {
    await vi.waitFor(() => expect(store.getSnapshot().ready).toBe(true));
    expect(await store.setDir("C:\\recordings")).toBe(true);
    expect(store.getSnapshot().dir).toBe("C:\\recordings");
    expect(store.getSnapshot().dirError).toBeNull();

    desktopState.state = { ...desktopState.state, active: true };
    desktopState.stateCb?.({ ...desktopState.state, active: true });
    expect(await store.setDir("C:\\other")).toBe(false);
    expect(store.getSnapshot().dirError).toMatch(/active/i);
  });

  it("refreshList replaces the snapshot list", async () => {
    await vi.waitFor(() => expect(store.getSnapshot().ready).toBe(true));
    desktopState.list = [
      { path: "/a.pcap", bytes: 10, frames: 1, startedMs: 1 },
      { path: "/b.pcap", bytes: 20, frames: null, startedMs: 2 },
    ];
    await store.refreshList();
    expect(store.getSnapshot().list).toHaveLength(2);
    expect(store.getSnapshot().list[0]!.path).toBe("/a.pcap");
  });
});
