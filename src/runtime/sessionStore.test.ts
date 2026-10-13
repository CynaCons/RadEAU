import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  sessionCb: null as ((s: unknown) => void) | null,
  linkCb: null as ((s: unknown) => void) | null,
  statsCb: null as ((s: unknown) => void) | null,
  captureStateCb: null as ((s: unknown) => void) | null,
  mirrorRunning: false,
}));

vi.mock("./desktop", () => ({
  startCapture: vi.fn(async (source: { kind: string; addr?: string }) => {
    if (source.kind === "sim") {
      throw new Error("simulator link is desktop-app only");
    }
    if (source.kind === "pcap" || source.kind === "pcapStream" || source.kind === "live") {
      throw new Error(`${source.kind} is desktop-app only`);
    }
    desktopState.mirrorRunning = true;
    desktopState.sessionCb?.({
      sourceKind: "devgen",
      scenario: null,
      endpoints: [{ name: "10.42.0.11", ip: "10.42.0.11" }],
      sessionEpochMs: Date.now(),
      timestampSource: "host",
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
  onCaptureState: vi.fn((cb: (s: unknown) => void) => {
    desktopState.captureStateCb = cb;
    return () => {
      desktopState.captureStateCb = null;
    };
  }),
  appInfo: vi.fn(async () => ({
    version: "0.1.0",
    buildProfile: "browser",
    os: "test",
    devgenAvailable: true,
  })),
  dependencyProbe: vi.fn(async () => [
    {
      id: "npcap",
      name: "Npcap",
      enables: "Windows live capture",
      status: "not-applicable",
      version: null,
      path: null,
      detail: "desktop app only",
      downloadUrl: "https://npcap.com/#download",
    },
    {
      id: "libpcap",
      name: "libpcap",
      enables: "Linux live capture",
      status: "not-applicable",
      version: null,
      path: null,
      detail: "desktop app only",
      downloadUrl: "https://www.tcpdump.org/",
    },
    {
      id: "vxlapi",
      name: "Vector XL Driver Library",
      enables: "Vector VN interfaces",
      status: "not-applicable",
      version: null,
      path: null,
      detail: "desktop app only",
      downloadUrl: "https://www.vector.com/int/en/download/xl-driver-library/",
    },
    {
      id: "vector-driver",
      name: "Vector driver package",
      enables: "Vector VN interfaces",
      status: "not-applicable",
      version: null,
      path: null,
      detail: "desktop app only",
      downloadUrl: "https://vector.com/latest_driver",
    },
  ]),
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

  it("keeps a stop requested during start from being overwritten by start completion", async () => {
    let resolveStart!: (started: boolean) => void;
    vi.mocked(startCapture).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const starting = store.start();
    const stopping = store.stop();
    resolveStart(true);
    await Promise.all([starting, stopping]);

    // Once for the immediate stop request, then again after the core start
    // resolves so a start that won the core-side race is also torn down.
    expect(stopCapture).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().running).toBe(false);
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
      recordingFrames: 0,
      recordingBytes: 0,
      recordingDropped: 0,
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

  it("locks pcap path/pace/stream addr while running", async () => {
    store.setSourceKind("pcap");
    store.setPcapPath("a.pcap");
    store.setPcapPace("fast");
    expect(store.getSnapshot().pcapPath).toBe("a.pcap");
    expect(store.getSnapshot().pcapPace).toBe("fast");
    expect(store.currentSource()).toEqual({
      kind: "pcap",
      path: "a.pcap",
      pace: "fast",
    });

    // Switch to devgen so start succeeds under the browser mock.
    store.setSourceKind("devgen");
    await store.start();
    store.setPcapPath("b.pcap");
    store.setPcapPace("realtime");
    store.setPcapStreamAddr("1.2.3.4:9");
    expect(store.getSnapshot().pcapPath).toBe("a.pcap");
    expect(store.getSnapshot().pcapPace).toBe("fast");
    expect(store.getSnapshot().pcapStreamAddr).toBe("");
    await store.stop();

    store.setPcapStreamAddr("127.0.0.1:5561");
    expect(store.getSnapshot().pcapStreamAddr).toBe("127.0.0.1:5561");
  });

  it("stores live interface/filter and locks them while running", async () => {
    store.setSourceKind("live");
    store.setLiveInterfaceId("\\Device\\NPF_Loopback");
    store.setLiveFilter("udp");
    expect(store.getSnapshot().sourceKind).toBe("live");
    expect(store.getSnapshot().liveInterfaceId).toBe("\\Device\\NPF_Loopback");
    expect(store.getSnapshot().liveFilter).toBe("udp");
    expect(store.currentSource()).toEqual({
      kind: "live",
      interfaceId: "\\Device\\NPF_Loopback",
      filter: "udp",
    });

    store.setLiveFilter("");
    expect(store.currentSource()).toEqual({
      kind: "live",
      interfaceId: "\\Device\\NPF_Loopback",
      filter: null,
    });

    // Start fails (desktop-only) but first flip to a startable source to lock.
    store.setSourceKind("devgen");
    await store.start();
    store.setLiveInterfaceId("eth0");
    store.setLiveFilter("arp");
    expect(store.getSnapshot().liveInterfaceId).toBe("\\Device\\NPF_Loopback");
    expect(store.getSnapshot().liveFilter).toBe("");
    await store.stop();

    store.setLiveInterfaceId("eth0");
    store.setLiveFilter("arp");
    expect(store.getSnapshot().liveInterfaceId).toBe("eth0");
    expect(store.getSnapshot().liveFilter).toBe("arp");
  });

  it("setPcapSource configures the Interface for Replay Browse", () => {
    store.setPcapSource("C:\\fixtures\\demo.pcap", "fast");
    const snap = store.getSnapshot();
    expect(snap.sourceKind).toBe("pcap");
    expect(snap.pcapPath).toBe("C:\\fixtures\\demo.pcap");
    expect(snap.pcapPace).toBe("fast");
  });

  it("CP-005: closed link while running ends the session and keeps closed status + stats", async () => {
    await store.start();
    desktopState.statsCb?.({
      seq: 2,
      elapsedS: 5,
      received: 42,
      emitted: 42,
      accumulatorDropped: 0,
      gapRecords: 0,
      gapDropped: 0,
      malformed: 0,
      kernelDropped: 0,
      byClass: new Array(12).fill(0),
      recordingFrames: 0,
      recordingBytes: 0,
      recordingDropped: 0,
    });
    expect(store.getSnapshot().running).toBe(true);

    desktopState.linkCb?.({
      state: "closed",
      detail: "end of file · 42 frames",
    });

    const snap = store.getSnapshot();
    expect(snap.running).toBe(false);
    expect(snap.linkStatus?.state).toBe("closed");
    expect(snap.linkStatus?.detail).toBe("end of file · 42 frames");
    expect(snap.stats?.received).toBe(42);
    expect(snap.sessionInfo?.sourceKind).toBe("devgen");
    expect(stopCapture).not.toHaveBeenCalled();
  });

  it("AU-003 mirrors agent capture:state without invoking capture commands", () => {
    desktopState.captureStateCb?.({
      running: true,
      source: { kind: "pcap", path: "C:\\agent\\drive.pcapng", pace: "fast" },
    });

    const snap = store.getSnapshot();
    expect(snap.running).toBe(true);
    expect(snap.sourceKind).toBe("pcap");
    expect(snap.pcapPath).toBe("C:\\agent\\drive.pcapng");
    expect(snap.pcapPace).toBe("fast");
    expect(startCapture).not.toHaveBeenCalled();
    expect(stopCapture).not.toHaveBeenCalled();

    desktopState.captureStateCb?.({ running: false, source: null });
    expect(store.getSnapshot().running).toBe(false);
    expect(stopCapture).not.toHaveBeenCalled();
  });
});
