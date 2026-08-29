/**
 * Browser-mode fallbacks for the new v0.1.6 desktop wrappers. Vitest has no
 * __TAURI_INTERNALS__, so isDesktop() is false and every call takes the
 * honest browser path.
 */

import { describe, expect, it } from "vitest";

import {
  catalogDiagnostics,
  catalogImport,
  catalogReload,
  dependencyProbe,
  diagnosticsReport,
  exportRing,
  isDesktop,
  listInterfaces,
  logPath,
  pickArxmlFile,
  pickPcapFile,
  pickSavePath,
} from "./desktop";

describe("desktop browser fallbacks (v0.1.6)", () => {
  it("is not desktop under vitest", () => {
    expect(isDesktop()).toBe(false);
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

  it("pickPcapFile returns null (editable path field stays usable)", async () => {
    expect(await pickPcapFile()).toBeNull();
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
