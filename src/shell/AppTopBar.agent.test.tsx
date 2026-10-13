// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  automationCb: null as ((s: unknown) => void) | null,
  captureStateCb: null as ((s: unknown) => void) | null,
}));

vi.mock("../runtime/desktop", () => ({
  closeWindow: vi.fn(),
  minimizeWindow: vi.fn(),
  toggleMaximizeWindow: vi.fn(),
  onMaximizedChange: vi.fn((cb: (maximized: boolean) => void) => {
    cb(false);
    return () => {};
  }),
  onAutomationClients: vi.fn((cb: (s: unknown) => void) => {
    desktopState.automationCb = cb;
    return () => {
      desktopState.automationCb = null;
    };
  }),
  startCapture: vi.fn(async () => true),
  stopCapture: vi.fn(async () => {}),
  onCaptureSession: vi.fn(() => () => {}),
  onCaptureLink: vi.fn(() => () => {}),
  onCaptureStats: vi.fn(() => () => {}),
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
  dependencyProbe: vi.fn(async () => []),
  onRecordingState: vi.fn(() => () => {}),
  recordingArm: vi.fn(async (armed: boolean) => ({
    armed,
    active: false,
    path: null,
    frames: 0,
    bytes: 0,
    dropped: 0,
    error: null,
    dir: "browser",
    startedMs: null,
  })),
  recordingDirSet: vi.fn(async (dir: string) => dir),
  recordingList: vi.fn(async () => []),
  recordingState: vi.fn(async () => ({
    armed: false,
    active: false,
    path: null,
    frames: 0,
    bytes: 0,
    dropped: 0,
    error: null,
    dir: "browser",
    startedMs: null,
  })),
}));

import { AppTopBar } from "./AppTopBar";

describe("AppTopBar automation mirroring", () => {
  let host: HTMLDivElement;
  let root: Root;
  const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(AppTopBar, { onToggleRail: vi.fn() })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("AU-003 flips the run control from capture:state without local commands", async () => {
    expect(q("appbar-run-btn")?.textContent).toMatch(/start/i);

    await act(async () => {
      desktopState.captureStateCb?.({
        running: true,
        source: { kind: "sim", addr: "127.0.0.1:5560" },
      });
    });

    expect(q("appbar-run-btn")?.textContent).toMatch(/stop/i);
  });

  it("AU-009 shows and hides the Agent chip from automation:clients", async () => {
    expect(q("appbar-agent-chip")).toBeNull();

    await act(async () => {
      desktopState.automationCb?.({ count: 2, lastMethod: "capture_start" });
    });

    const chip = q("appbar-agent-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Agent");
    expect(chip?.getAttribute("aria-label")).toBe("2 agent client(s) · last: capture_start");

    await act(async () => {
      desktopState.automationCb?.({ count: 0, lastMethod: "capture_stop" });
    });

    expect(q("appbar-agent-chip")).toBeNull();
  });
});
