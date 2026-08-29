import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopState = vi.hoisted(() => ({
  calls: 0,
  info: {
    version: "0.1.0",
    buildProfile: "browser" as const,
    os: "Win32",
    devgenAvailable: true,
  },
}));

vi.mock("./desktop", () => ({
  appInfo: vi.fn(async () => {
    desktopState.calls += 1;
    return { ...desktopState.info };
  }),
}));

import { AppInfoStore } from "./appInfoStore";
import { appInfo } from "./desktop";

describe("AppInfoStore", () => {
  beforeEach(() => {
    desktopState.calls = 0;
    desktopState.info = {
      version: "0.1.0",
      buildProfile: "browser",
      os: "Win32",
      devgenAvailable: true,
    };
    vi.clearAllMocks();
  });

  it("fetches once and caches the result", async () => {
    const store = new AppInfoStore();
    const a = await store.ensureLoaded();
    const b = await store.ensureLoaded();
    expect(a).toEqual(desktopState.info);
    expect(b).toEqual(desktopState.info);
    expect(appInfo).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().ready).toBe(true);
    expect(store.getSnapshot().info.buildProfile).toBe("browser");
  });
});
