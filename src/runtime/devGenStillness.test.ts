/**
 * Stopped-state stillness (SRS_visual_ui.md §4.3): the browser-mode dev-gen
 * mirror must not emit batches unless the shared session is running.
 */

import { afterEach, describe, expect, it } from "vitest";

import { onFrameBatch, startCapture, stopCapture } from "./desktop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("dev-gen mirror stillness", () => {
  afterEach(async () => {
    await stopCapture();
  });

  it("emits nothing while stopped, ticks only after start, and stops on stop", async () => {
    const sizes: number[] = [];
    const unsub = onFrameBatch((b) => sizes.push(b.i.length));

    await sleep(80);
    expect(sizes).toEqual([]);

    await startCapture({ kind: "devgen", profile: "normal" });
    await sleep(80);
    expect(sizes.length).toBeGreaterThan(0);

    const atStop = sizes.length;
    await stopCapture();
    await sleep(80);
    expect(sizes.length).toBe(atStop);

    unsub();
  });
});
