import { describe, expect, it } from "vitest";

import {
  defaultExportPcapName,
  formatExportSummary,
} from "./ringExport";

describe("ringExport helpers", () => {
  it("builds radeau-yyyyMMdd-HHmmss.pcap names", () => {
    const name = defaultExportPcapName(new Date(2026, 7, 29, 14, 5, 9));
    expect(name).toBe("radeau-20260829-140509.pcap");
  });

  it("summarizes an export result", () => {
    expect(
      formatExportSummary({
        frames: 1200,
        bytes: 2048,
        firstTsMs: 0,
        lastTsMs: 1000,
      }),
    ).toBe("Exported 1,200 frames · 2 KB");
  });
});
