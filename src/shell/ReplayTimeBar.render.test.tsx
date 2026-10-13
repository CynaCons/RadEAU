// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  positionCb: null as ((p: unknown) => void) | null,
  seekCb: null as ((s: unknown) => void) | null,
}));

vi.mock("../runtime/desktop", () => ({
  replayOpen: vi.fn(async (path: string) => ({
    path,
    frames: 100,
    firstTsNs: 0,
    lastTsNs: 987_654_000_000,
    durationNs: 987_654_000_000,
    interfaces: ["pcap"],
    comment: "replay comment",
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
  startCapture: vi.fn(async () => true),
  stopCapture: vi.fn(async () => {}),
  onCaptureSession: vi.fn(() => () => {}),
  onCaptureLink: vi.fn(() => () => {}),
  onCaptureStats: vi.fn(() => () => {}),
  appInfo: vi.fn(async () => ({
    version: "0.1.0",
    buildProfile: "browser",
    os: "test",
    devgenAvailable: true,
  })),
  dependencyProbe: vi.fn(async () => []),
}));

import { replayPause, replayPlay, replaySeek, replaySetSpeed, replayStep } from "../runtime/desktop";
import { replayStore } from "../runtime/replayStore";
import { sessionStore } from "../runtime/sessionStore";
import { commitReplaySliderSeek, ReplayTimeBar } from "./ReplayTimeBar";

async function renderBar() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ReplayTimeBar)));
  return { host, root };
}

async function unmount(root: Root, host: HTMLElement) {
  await act(async () => root.unmount());
  host.remove();
}

function emitPosition(state: "playing" | "paused" | "ended", tNs: number, speed: number | null = 1) {
  act(() => {
    desktopState.positionCb?.({
      state,
      tNs,
      frame: 3,
      frames: 100,
      durationNs: 987_654_000_000,
      speed,
    });
  });
}

describe("ReplayTimeBar", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sessionStore.setSourceKind("devgen");
    await act(async () => replayStore.open("C:\\trace\\fixture.pcapng"));
    sessionStore.setSourceKind("devgen");
  });

  it("is visible only for pcap replay sources (VU-028)", async () => {
    const { host, root } = await renderBar();
    expect(host.querySelector('[data-testid="replay-bar"]')).toBeNull();

    await act(async () => sessionStore.setPcapSource("C:\\trace\\fixture.pcapng"));
    expect(host.querySelector('[data-testid="replay-bar"]')).not.toBeNull();

    await unmount(root, host);
  });

  it("formats the position label at three decimals (VU-028)", async () => {
    await act(async () => sessionStore.setPcapSource("C:\\trace\\fixture.pcapng"));
    const { host, root } = await renderBar();

    emitPosition("paused", 12_345_000_000);
    expect(host.querySelector('[data-testid="replay-position"]')?.textContent).toBe(
      "12.345s / 987.654s",
    );

    await unmount(root, host);
  });

  it("disables step and seek until the replay session runs (VU-028)", async () => {
    await act(async () => sessionStore.setPcapSource("C:\\trace\\fixture.pcapng"));
    const { host, root } = await renderBar();
    emitPosition("paused", 0);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="replay-step-btn"]')?.disabled).toBe(true);
    await unmount(root, host);
  });

  it("calls play/pause/step and speed controls (CP-021/VU-028)", async () => {
    await act(async () => sessionStore.setPcapSource("C:\\trace\\fixture.pcapng"));
    // A running replay session (the browser test build cannot start a pcap source).
    const running = { ...sessionStore.getSnapshot(), running: true };
    const snapshot = vi.spyOn(sessionStore, "getSnapshot").mockReturnValue(running);
    const { host, root } = await renderBar();

    emitPosition("paused", 0);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="replay-step-btn"]')?.click();
    });
    expect(replayStep).toHaveBeenCalledTimes(1);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="replay-play-btn"]')?.click();
    });
    expect(replayPlay).toHaveBeenCalledTimes(1);

    emitPosition("playing", 1_000_000_000);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="replay-play-btn"]')?.click();
    });
    expect(replayPause).toHaveBeenCalledTimes(1);

    // MUI Select: open the menu from its combobox, pick the option (portal).
    const combo = host.querySelector<HTMLElement>('[data-testid="replay-bar"] [role="combobox"]');
    await act(async () => {
      combo?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    const maxOption = document.body.querySelector<HTMLElement>('li[data-value="max"]');
    await act(async () => {
      maxOption?.click();
    });
    expect(replaySetSpeed).toHaveBeenCalledWith(null);

    snapshot.mockRestore();
    await unmount(root, host);
  });

  it("seeks only when the slider is released (CP-022/VU-028)", async () => {
    await act(async () => sessionStore.setPcapSource("C:\\trace\\fixture.pcapng"));
    const { host, root } = await renderBar();

    emitPosition("paused", 0);
    expect(host.querySelector('[data-testid="replay-slider"]')).not.toBeNull();
    expect(replaySeek).not.toHaveBeenCalled();

    commitReplaySliderSeek(123_000_000, (target) => replayStore.seek(target));
    expect(replaySeek).toHaveBeenCalledWith(123_000_000);

    await unmount(root, host);
  });
});
