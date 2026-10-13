/**
 * Browser-mode fallbacks for the new v0.1.6 desktop wrappers. Vitest has no
 * __TAURI_INTERNALS__, so isDesktop() is false and every call takes the
 * honest browser path.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  appInfo,
  catalogDiagnostics,
  catalogImport,
  catalogReload,
  dependencyProbe,
  diagnosticsReport,
  exportRing,
  exportJsonl,
  isDesktop,
  listInterfaces,
  onReplayPosition,
  onReplayPrepare,
  onReplaySeek,
  onReplayOpened,
  onAutomationClients,
  onCaptureState,
  logPath,
  onRecordingState,
  pickArxmlFile,
  pickDirectory,
  pickPcapFile,
  pickSavePath,
  recordingArm,
  recordingDirGet,
  recordingDirSet,
  recordingList,
  recordingState,
  replayOpen,
  replayPause,
  replayPlay,
  replaySeek,
  replaySetSpeed,
  replayStep,
} from "./desktop";

describe("desktop browser fallbacks (v0.1.6)", () => {
  it("is not desktop under vitest", () => {
    expect(isDesktop()).toBe(false);
  });

  it("appInfo returns the browser fallback shape", async () => {
    const info = await appInfo();
    expect(info.buildProfile).toBe("browser");
    expect(info.devgenAvailable).toBe(true);
    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
    expect(typeof info.os).toBe("string");
  });

  it("dependencyProbe returns four not-applicable rows", async () => {
    const rows = await dependencyProbe();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe("not-applicable");
      expect(row.detail).toBe("desktop app only");
    }
  });

  it("diagnosticsReport is a short honest browser-mode report", async () => {
    const report = await diagnosticsReport();
    expect(report).toContain("RadEAU");
    expect(report.toLowerCase()).toContain("browser");
    expect(report.toLowerCase()).toContain("log");
  });

  it("logPath returns an honest desktop-only placeholder", async () => {
    expect(await logPath()).toMatch(/desktop app only/i);
  });

  it("exportRing rejects honestly", async () => {
    await expect(exportRing("out.pcap")).rejects.toThrow(/desktop app only/i);
  });

  it("exportJsonl rejects honestly", async () => {
    await expect(exportJsonl("out.jsonl", { kind: "ring" })).rejects.toThrow(/desktop app only/i);
  });

  it("pickPcapFile returns null (editable path field stays usable)", async () => {
    expect(await pickPcapFile()).toBeNull();
  });

  describe("desktop browser fallbacks (replay CP-020..022)", () => {
    it("replay commands reject with the pinned desktop-only message", async () => {
      await expect(replayOpen("in.pcap")).rejects.toThrow(/replay is desktop-app only/i);
      await expect(replayPlay()).rejects.toThrow(/replay is desktop-app only/i);
      await expect(replayPause()).rejects.toThrow(/replay is desktop-app only/i);
      await expect(replayStep()).rejects.toThrow(/replay is desktop-app only/i);
      await expect(replaySeek(1)).rejects.toThrow(/replay is desktop-app only/i);
      await expect(replaySetSpeed(null)).rejects.toThrow(/replay is desktop-app only/i);
    });

    it("replay event listeners are browser no-ops", () => {
      expect(onReplayPosition(() => {})()).toBeUndefined();
      expect(onReplaySeek(() => {})()).toBeUndefined();
      expect(onReplayPrepare(() => {})()).toBeUndefined();
      expect(onReplayOpened(() => {})()).toBeUndefined();
    });
  });

  it("automation event listeners are browser no-ops (AU-003/AU-009)", () => {
    expect(onCaptureState(() => {})()).toBeUndefined();
    expect(onAutomationClients(() => {})()).toBeUndefined();
  });

  it("pickSavePath rejects honestly", async () => {
    await expect(pickSavePath("radeau-test.pcap")).rejects.toThrow(/desktop app only/i);
  });

  it("listInterfaces rejects honestly", async () => {
    await expect(listInterfaces()).rejects.toThrow(/desktop app only/i);
  });
});

describe("desktop browser fallbacks (v0.1.8 catalog)", () => {
  it("catalogImport / catalogReload / catalogDiagnostics reject honestly", async () => {
    await expect(catalogImport("/tmp/x.arxml")).rejects.toThrow(/desktop app only/i);
    await expect(catalogReload()).rejects.toThrow(/desktop app only/i);
    await expect(catalogDiagnostics()).rejects.toThrow(/desktop app only/i);
  });

  it("pickArxmlFile rejects honestly", async () => {
    await expect(pickArxmlFile()).rejects.toThrow(/desktop app only/i);
  });
});

describe("desktop browser fallbacks (recording CP-014..016)", () => {
  beforeEach(async () => {
    await recordingArm(false);
    await recordingDirSet("browser");
  });

  it("recordingState starts idle with dir browser", async () => {
    const s = await recordingState();
    expect(s.armed).toBe(false);
    expect(s.active).toBe(false);
    expect(s.path).toBeNull();
    expect(s.dir).toBe("browser");
    expect(s.frames).toBe(0);
    expect(s.error).toBeNull();
  });

  it("recordingArm toggles armed without opening a file", async () => {
    const armed = await recordingArm(true);
    expect(armed.armed).toBe(true);
    expect(armed.active).toBe(false);
    expect(armed.path).toBeNull();

    const idle = await recordingArm(false);
    expect(idle.armed).toBe(false);
  });

  it("recordingDirSet / recordingDirGet round-trip in memory", async () => {
    expect(await recordingDirSet("/tmp/rec")).toBe("/tmp/rec");
    expect(await recordingDirGet()).toBe("/tmp/rec");
  });

  it("recordingList is empty and pickDirectory rejects", async () => {
    expect(await recordingList()).toEqual([]);
    await expect(pickDirectory()).rejects.toThrow(/desktop app only/i);
  });

  it("onRecordingState delivers arm transitions", async () => {
    const seen: boolean[] = [];
    const unsub = onRecordingState((s) => {
      seen.push(s.armed);
    });
    await recordingArm(true);
    await recordingArm(false);
    unsub();
    expect(seen).toEqual([true, false]);
  });
});
