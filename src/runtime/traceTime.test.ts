import { describe, expect, it } from "vitest";

import {
  formatSessionTime,
  formatTraceTime,
  formatWallTime,
  wallTimeDisabledReason,
} from "./traceTime";

describe("traceTime formatting", () => {
  it("formats session time to 4 decimal places", () => {
    expect(formatSessionTime(0)).toBe("0.0000");
    expect(formatSessionTime(1.23456)).toBe("1.2346");
    expect(formatSessionTime(12.5)).toBe("12.5000");
  });

  it("formats wall time as local HH:MM:SS.mmm", () => {
    // 2024-01-15 12:34:56.789 local — build from local components so the
    // assertion is timezone-stable.
    const epoch = new Date(2024, 0, 15, 12, 34, 56, 789).getTime();
    expect(formatWallTime(0, epoch)).toBe("12:34:56.789");
    expect(formatWallTime(1.5, epoch)).toBe("12:34:58.289");
  });

  it("formatTraceTime honors mode and falls back when epoch is null", () => {
    const epoch = new Date(2024, 0, 15, 8, 0, 0, 0).getTime();
    expect(formatTraceTime(1.25, "session", epoch)).toBe("1.2500");
    expect(formatTraceTime(1.25, "session", null)).toBe("1.2500");
    expect(formatTraceTime(0, "wall", epoch)).toBe("08:00:00.000");
    expect(formatTraceTime(1.25, "wall", null)).toBe("1.2500");
  });

  it("disables wall mode with the pinned reason when epoch is null", () => {
    expect(wallTimeDisabledReason(null)).toBe("source has no wall-clock anchor");
    expect(wallTimeDisabledReason(1_700_000_000_000)).toBeNull();
  });
});
