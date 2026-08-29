/**
 * Browser-mode fallbacks for the new v0.1.6 desktop wrappers. Vitest has no
 * __TAURI_INTERNALS__, so isDesktop() is false and every call takes the
 * honest browser path.
 */

import { describe, expect, it } from "vitest";

import {
  dependencyProbe,
  diagnosticsReport,
  exportRing,
  isDesktop,
  logPath,
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
});
