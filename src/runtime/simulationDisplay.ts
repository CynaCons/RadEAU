/**
 * Simulation view honesty copy (SRS_visual_ui.md §5.4) — no mock signal
 * controls until the simulation core lands in v0.7.
 */

export const SIM_EMPTY = {
  node: "node simulation arrives v0.7",
  signal: "signal simulation arrives v0.7",
  "frame-gen": "frame generation arrives v0.7",
  presets: "presets arrive v0.7",
} as const;

export type SimPageId = keyof typeof SIM_EMPTY;
