import { beforeEach, describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({
  pickSavePath: vi.fn<(name: string) => Promise<string | null>>(),
  exportRing: vi.fn(),
  onCaptureExport: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("./desktop", () => ({
  pickSavePath: desktop.pickSavePath,
  exportRing: desktop.exportRing,
  onCaptureExport: (cb: (p: { done: number; total: number }) => void) => {
    desktop.onCaptureExport(cb);
    return desktop.unsubscribe;
  },
}));

import { exportErrorMessage, runExportRing } from "./ringExport";

// CP-006 / TR-013: the shared export action (Trace rail and Recorder).
describe("runExportRing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'export cancelled' without touching the core when no path is picked", async () => {
    desktop.pickSavePath.mockResolvedValue(null);
    await expect(runExportRing()).resolves.toEqual({ ok: false, message: "export cancelled" });
    expect(desktop.pickSavePath.mock.calls[0]?.[0]).toMatch(/^radeau-\d{8}-\d{6}\.pcap$/);
    expect(desktop.exportRing).not.toHaveBeenCalled();
  });

  it("writes the ring, forwards progress and unsubscribes", async () => {
    desktop.pickSavePath.mockResolvedValue("C:/tmp/out.pcap");
    desktop.exportRing.mockImplementation(async () => {
      const progress = desktop.onCaptureExport.mock.calls[0]?.[0] as (p: { done: number; total: number }) => void;
      progress({ done: 5, total: 10 });
      return { frames: 10, bytes: 4096, firstTsMs: 0, lastTsMs: 1 };
    });
    const onProgress = vi.fn();
    const outcome = await runExportRing(onProgress);
    expect(outcome).toMatchObject({ ok: true, message: "Exported 10 frames · 4 KB", path: "C:/tmp/out.pcap" });
    expect(onProgress).toHaveBeenCalledWith({ done: 5, total: 10 });
    expect(desktop.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports the core's error verbatim and still unsubscribes", async () => {
    desktop.pickSavePath.mockResolvedValue("C:/tmp/out.pcap");
    desktop.exportRing.mockRejectedValue(new Error("no frames buffered"));
    await expect(runExportRing(() => {})).resolves.toEqual({ ok: false, message: "no frames buffered" });
    expect(desktop.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("maps dialog failures and non-Error rejections to messages", async () => {
    desktop.pickSavePath.mockRejectedValue("dialog unavailable");
    await expect(runExportRing()).resolves.toEqual({ ok: false, message: "dialog unavailable" });
    expect(exportErrorMessage(42)).toBe("42");
  });
});
