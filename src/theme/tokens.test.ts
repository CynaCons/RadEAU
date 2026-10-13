import { describe, expect, it } from "vitest";
import tokens from "./tokens.json";

// VU-003: flat-surface tokens do not introduce depth-dependent panel colors.
// VU-004/VU-026: the series palette contains exactly the 16 specified colors
// in the specified order. VU-001/VU-002 companions: token values match the
// visual specification exactly.
function linearChannel(hex: string, offset: number): number {
  const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  return 0.2126 * linearChannel(hex, 1) + 0.7152 * linearChannel(hex, 3) + 0.0722 * linearChannel(hex, 5);
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("token source of truth", () => {
  it("contains exactly the 16 series colors in order (VU-004)", () => {
    expect(tokens.series).toEqual([
      "#58a6ff",
      "#8b5cf6",
      "#3fb950",
      "#f85149",
      "#d29922",
      "#db6d28",
      "#2ea043",
      "#ff7b72",
      "#a371f7",
      "#79c0ff",
      "#ff9bce",
      "#ffd33d",
      "#7ee787",
      "#ffa657",
      "#c9d1d9",
      "#56d4dd",
    ]);
  });

  it("positions 1–4 coincide with info, accent-secondary, success, error", () => {
    expect(tokens.series[0]).toBe(tokens.color["info"]);
    expect(tokens.series[1]).toBe(tokens.color["accent-secondary"]);
    expect(tokens.series[2]).toBe(tokens.color["success"]);
    expect(tokens.series[3]).toBe(tokens.color["error"]);
  });

  it("defines the normative surface and accent values", () => {
    expect(tokens.color["surface-canvas"]).toBe("#0d1117");
    expect(tokens.color["surface-raised"]).toBe("#161b22");
    expect(tokens.color["surface-raised-2"]).toBe("#21262d");
    expect(tokens.color["border"]).toBe("#30363d");
    expect(tokens.color["accent-primary"]).toBe("#5090ea");
    expect(tokens.color["text-primary"]).toBe("#e6edf3");
    expect(tokens.color["text-on-plot"]).toBe("#ffffff");
  });

  it("every semantic token has exactly one -dark variant", () => {
    for (const base of ["accent-primary", "accent-secondary", "info", "success", "warning", "error"]) {
      expect(tokens.color[`${base}-dark` as keyof typeof tokens.color]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("meets text and series contrast targets against dark surfaces (VU-026)", () => {
    const textColors = [
      "text-primary",
      "text-secondary",
      "text-tertiary",
      "text-on-plot",
    ] as const;
    const surfaces = ["surface-canvas", "surface-raised"] as const;

    for (const text of textColors) {
      for (const surface of surfaces) {
        expect(contrastRatio(tokens.color[text], tokens.color[surface])).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const color of tokens.series) {
      for (const surface of surfaces) {
        expect(contrastRatio(color, tokens.color[surface])).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
