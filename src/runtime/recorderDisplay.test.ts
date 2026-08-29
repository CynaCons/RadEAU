import { describe, expect, it } from "vitest";

import {
  RECORDER_EMPTY,
  RECORDER_RECORDING_CAPTION,
  RECORDER_REPLAY_CAPTION,
  recorderExportLabel,
} from "./recorderDisplay";

/** Fabricated recent-capture basenames that must never reappear. */
const FABRICATED = [
  "20260826-1402_fusion-baseline.jsonl",
  "20260825-1731_sd-reboot-fault.jsonl",
  "20260825-0918_ptp-convergence.jsonl",
  "20260824-1650_burst-stress.jsonl",
  "20260824-1101_camera-dropout.jsonl",
];

describe("recorderDisplay honesty", () => {
  it("uses the pinned empty-state and v0.6 captions", () => {
    expect(RECORDER_EMPTY).toBe("no recordings yet");
    expect(RECORDER_RECORDING_CAPTION).toMatch(/v0\.6/);
    expect(RECORDER_REPLAY_CAPTION).toMatch(/Press Start/i);
  });

  it("never embeds fabricated recent-capture names", () => {
    const corpus = [
      RECORDER_EMPTY,
      RECORDER_RECORDING_CAPTION,
      RECORDER_REPLAY_CAPTION,
      recorderExportLabel(0),
      recorderExportLabel(42),
    ].join("\n");
    for (const bad of FABRICATED) {
      expect(corpus.includes(bad), `fabricated string leaked: ${bad}`).toBe(false);
    }
  });

  it("labels Export with the buffered frame count", () => {
    expect(recorderExportLabel(0)).toBe("Export buffered frames");
    expect(recorderExportLabel(1200)).toBe("Export buffered frames · 1,200");
  });
});
