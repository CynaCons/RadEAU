import { describe, expect, it } from "vitest";

import {
  catalogBadgeTone,
  catalogCountsLabel,
  catalogDiagCountLabel,
  catalogFileName,
  catalogLastErrorMessage,
  catalogSeverityGlyph,
  catalogSourceLabel,
  CATALOG_NO_DIAGNOSTICS,
} from "./catalogDisplay";

describe("catalogDisplay popover model", () => {
  it("labels embedded as the demo catalog and file sources by basename", () => {
    expect(catalogSourceLabel("catalog/sensor-fusion.arxml", "embedded")).toBe(
      "embedded demo catalog",
    );
    expect(catalogSourceLabel("C:\\bench\\extract.arxml", "file")).toBe("extract.arxml");
    expect(catalogSourceLabel("/tmp/net.arxml", "env")).toBe("net.arxml");
    expect(catalogFileName("a/b/c.arxml")).toBe("c.arxml");
  });

  it("formats counts and diagnostics summary lines", () => {
    expect(catalogCountsLabel(1, 1)).toBe("1 service · 1 signal");
    expect(catalogCountsLabel(2, 5)).toBe("2 services · 5 signals");
    expect(catalogDiagCountLabel(0, 0)).toBe("0 errors / 0 warnings");
    expect(catalogDiagCountLabel(1, 2)).toBe("1 error / 2 warnings");
    expect(CATALOG_NO_DIAGNOSTICS).toBe("no diagnostics");
  });

  it("picks badge tone: hidden / success / warning / error", () => {
    expect(
      catalogBadgeTone({ loaded: false, errors: 0, warnings: 0, lastError: null }),
    ).toBe("hidden");
    expect(
      catalogBadgeTone({ loaded: true, errors: 0, warnings: 0, lastError: null }),
    ).toBe("success");
    expect(
      catalogBadgeTone({ loaded: true, errors: 0, warnings: 1, lastError: null }),
    ).toBe("warning");
    expect(
      catalogBadgeTone({ loaded: true, errors: 2, warnings: 0, lastError: null }),
    ).toBe("warning");
    expect(
      catalogBadgeTone({
        loaded: true,
        errors: 0,
        warnings: 0,
        lastError: "XML syntax error",
      }),
    ).toBe("error");
  });

  it("last-error copy keeps the previous catalog and the message verbatim", () => {
    expect(catalogLastErrorMessage("unreadable file")).toBe(
      "Previous catalog stays active. unreadable file",
    );
  });

  it("maps severity to a glyph", () => {
    expect(catalogSeverityGlyph("error")).toBeTruthy();
    expect(catalogSeverityGlyph("warn")).toBeTruthy();
    expect(catalogSeverityGlyph("info")).toBeTruthy();
  });
});
