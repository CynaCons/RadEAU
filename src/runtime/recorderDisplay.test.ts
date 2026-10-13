import { describe, expect, it } from "vitest";

import {
  RECORDER_DIR_CAPTION,
  RECORDER_EMPTY,
  RECORDER_REPLAY_CAPTION,
  formatActiveRecordingStats,
  formatRecordingBytes,
  recordIndicatorColor,
  recordIndicatorTooltip,
  recorderExportLabel,
  recordingBasename,
  recordingChipLabel,
  recordingListModel,
} from "./recorderDisplay";

/** Fabricated recent-capture basenames that must never reappear. */
const FABRICATED = [
  "20260826-1402_fusion-baseline.jsonl",
  "20260825-1731_sd-reboot-fault.jsonl",
  "20260825-0918_ptp-convergence.jsonl",
  "20260824-1650_burst-stress.jsonl",
  "20260824-1101_camera-dropout.jsonl",
];

describe("recorderDisplay", () => {
  it("uses the pinned empty-state and directory caption (no v0.6 stub)", () => {
    expect(RECORDER_EMPTY).toBe("no recordings yet");
    expect(RECORDER_DIR_CAPTION).toMatch(/Documents/i);
    expect(RECORDER_DIR_CAPTION).not.toMatch(/v0\.6/);
    expect(RECORDER_REPLAY_CAPTION).toMatch(/Press Start/i);
  });

  it("never embeds fabricated recent-capture names", () => {
    const corpus = [
      RECORDER_EMPTY,
      RECORDER_DIR_CAPTION,
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

  it("picks indicator color: error while writing, warning armed, else idle", () => {
    expect(recordIndicatorColor({ armed: false, active: false, frames: 0 })).toBe(
      "var(--text-secondary)",
    );
    expect(recordIndicatorColor({ armed: true, active: false, frames: 0 })).toBe(
      "var(--warning)",
    );
    expect(recordIndicatorColor({ armed: true, active: true, frames: 0 })).toBe(
      "var(--warning)",
    );
    expect(recordIndicatorColor({ armed: true, active: true, frames: 12 })).toBe(
      "var(--error)",
    );
  });

  it("builds indicator tooltips for idle / armed / active", () => {
    expect(
      recordIndicatorTooltip({ armed: false, active: false, path: null }),
    ).toBe("Recording idle");
    expect(
      recordIndicatorTooltip({ armed: true, active: false, path: null }),
    ).toBe("Recording armed — starts with the next session");
    expect(
      recordIndicatorTooltip({
        armed: true,
        active: true,
        path: "C:\\rec\\radeau-20260101-120000.pcap",
      }),
    ).toBe("Recording · C:\\rec\\radeau-20260101-120000.pcap");
  });

  it("formats basenames, bytes, active stats, and list rows", () => {
    expect(recordingBasename("C:\\docs\\RadEAU\\radeau-1.pcap")).toBe("radeau-1.pcap");
    expect(recordingBasename("/tmp/rec/out.pcap")).toBe("out.pcap");
    expect(formatRecordingBytes(512)).toBe("512 B");
    expect(formatRecordingBytes(2048)).toBe("2 KB");
    expect(
      formatActiveRecordingStats({ frames: 1200, bytes: 4096, dropped: 3 }),
    ).toBe("1,200 frames · 4 KB · 3 dropped");
    expect(recordingChipLabel(42)).toBe("Recording · 42 frames");

    const rows = recordingListModel([
      {
        path: "C:\\rec\\radeau-b.pcap",
        bytes: 2048,
        frames: 10,
        startedMs: 200,
      },
      {
        path: "C:\\rec\\radeau-a.pcap",
        bytes: 100,
        frames: null,
        startedMs: 100,
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.basename).toBe("radeau-b.pcap");
    expect(rows[0]!.bytesLabel).toBe("2 KB");
    expect(rows[0]!.framesLabel).toBe("10 frames");
    expect(rows[1]!.framesLabel).toBeNull();
    expect(rows[1]!.bytesLabel).toBe("100 B");
  });
});
