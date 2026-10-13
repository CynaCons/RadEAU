import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  closeWindow,
  minimizeWindow,
  onMaximizedChange,
  toggleMaximizeWindow,
} from "./desktop";

describe("desktop window rejection handling", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    vi.restoreAllMocks();
  });

  it("warns instead of leaving rejected window promises unhandled", async () => {
    const rejected = () => Promise.reject(new Error("window unavailable"));
    windowApi.minimize.mockImplementation(rejected);
    windowApi.toggleMaximize.mockImplementation(rejected);
    windowApi.close.mockImplementation(rejected);
    windowApi.isMaximized.mockImplementation(rejected);
    windowApi.onResized.mockImplementation(rejected);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    minimizeWindow();
    toggleMaximizeWindow();
    closeWindow();
    onMaximizedChange(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledTimes(5);
  });
});
