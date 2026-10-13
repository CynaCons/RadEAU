import { describe, expect, it } from "vitest";

import {
  browserDependencyRows,
  dependencyChipModel,
  dependencyPathLine,
  liveCaptureDependency,
  liveCapturePlatform,
  type DependencyRow,
} from "./dependencyDisplay";

const ALLOWED_STATUS = new Set([
  "installed",
  "missing",
  "incompatible",
  "blocked",
  "not-applicable",
]);

describe("dependencyDisplay row model", () => {
  it("browser fallback yields four not-applicable rows with honest detail", () => {
    const rows = browserDependencyRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id)).toEqual([
      "npcap",
      "libpcap",
      "vxlapi",
      "vector-driver",
    ]);
    for (const row of rows) {
      expect(ALLOWED_STATUS.has(row.status)).toBe(true);
      expect(row.status).toBe("not-applicable");
      expect(row.detail).toBe("desktop app only");
      expect(row.downloadUrl).toMatch(/^https?:\/\//);
      const chip = dependencyChipModel(row);
      expect(chip.label).toBe("N/A");
      expect(chip.colorVar).toBe("var(--text-secondary)");
      expect(chip.showDownload).toBe(false);
    }
  });

  it("maps each status to chip label, token color, and download visibility", () => {
    const base: Omit<DependencyRow, "status" | "version"> = {
      id: "npcap",
      name: "Npcap",
      enables: "Windows live capture",
      path: "C:\\Windows\\System32\\Npcap\\wpcap.dll",
      detail: null,
      downloadUrl: "https://npcap.com/#download",
    };

    expect(
      dependencyChipModel({ ...base, status: "installed", version: "1.79" }),
    ).toEqual({
      label: "Installed · 1.79",
      colorVar: "var(--success)",
      showDownload: false,
    });
    expect(
      dependencyChipModel({ ...base, status: "missing", version: null }),
    ).toEqual({
      label: "Missing",
      colorVar: "var(--error)",
      showDownload: true,
    });
    expect(
      dependencyChipModel({ ...base, status: "incompatible", version: "0.9" }),
    ).toEqual({
      label: "Incompatible · 0.9",
      colorVar: "var(--warning)",
      showDownload: true,
    });
    expect(
      dependencyChipModel({ ...base, status: "blocked", version: "1.79" }),
    ).toEqual({
      label: "Blocked",
      colorVar: "var(--warning)",
      showDownload: true,
    });
  });

  it("formats the mono path/version line", () => {
    expect(
      dependencyPathLine({
        id: "npcap",
        name: "Npcap",
        enables: "x",
        status: "installed",
        version: "1.79",
        path: "C:\\wpcap.dll",
        detail: null,
        downloadUrl: "https://npcap.com/#download",
      }),
    ).toBe("C:\\wpcap.dll · 1.79");
    expect(
      dependencyPathLine({
        id: "libpcap",
        name: "libpcap",
        enables: "x",
        status: "missing",
        version: null,
        path: null,
        detail: null,
        downloadUrl: "https://www.tcpdump.org/",
      }),
    ).toBeNull();
  });

  it("picks the applicable live-capture dependency for gating", () => {
    const windowsRows: DependencyRow[] = [
      {
        id: "npcap",
        name: "Npcap",
        enables: "Windows live capture",
        status: "installed",
        version: "1.79",
        path: "C:\\wpcap.dll",
        detail: null,
        downloadUrl: "https://npcap.com/#download",
      },
      {
        id: "libpcap",
        name: "libpcap",
        enables: "Linux live capture",
        status: "not-applicable",
        version: null,
        path: null,
        detail: null,
        downloadUrl: "https://www.tcpdump.org/",
      },
    ];
    expect(liveCaptureDependency(windowsRows)?.id).toBe("npcap");
    expect(liveCapturePlatform(windowsRows)).toBe("windows");

    const linuxRows: DependencyRow[] = [
      { ...windowsRows[0]!, status: "not-applicable", version: null, path: null },
      { ...windowsRows[1]!, status: "missing" },
    ];
    expect(liveCaptureDependency(linuxRows)?.id).toBe("libpcap");
    expect(liveCapturePlatform(linuxRows)).toBe("linux");

    expect(liveCaptureDependency(null)).toBeNull();
    expect(liveCaptureDependency(browserDependencyRows())?.id).toBe("npcap");
  });
});
