# SRS — Graphing

**Scope:** The chart subsystem — stack architecture, WebGL2 engine, Canvas2D
fallback, axis mathematics, interaction, autoscale, the live render loop,
multi-pane, and the FFT view. Behavior and structure only; pixels (colors,
strokes, paddings' visual tokens) are [SRS_visual_ui.md](SRS_visual_ui.md) §6.
Product context: [PRD.md](../PRD.md) §5. ID prefixes: `GR-`, `ZM-`, `AS-`,
`LM-`, `MG-`, `FF-`.

---

## 1. Chart stack

Four pieces, top down: **plot component** (owns data, viewport, render loop,
autoscale policy — the only piece that knows what a signal is), **chart host**
(selects/mounts a renderer, hosts the error boundary), **engine** (draws; owns no
policy, timers, or data), **overlays** (SVG axes; Canvas2D crosshair on its own
layer so cursor motion never redraws series). Layout math is renderer-neutral
pure functions shared by both engines.

Engine handle: `setData(data, resetScales?)`, `setViewport(viewport)`,
`getViewport()`, `setCursor(cursor|null)`, `screenToData`/`dataToScreen`,
`resize(w,h)`, `redraw()`, `getDiagnostics()`. Data is one aligned block: index 0
the monotonic X array, 1..N index-aligned Y arrays; non-finite Y is a gap (break
the line, never interpolate). Viewport `{xRange, yRange, yMode, isLive}`, ranges
`{min,max}|null`, `yMode ∈ {manual_locked, window_auto}`.

Renderer resolution: global override → persisted preference → GPU default with a
probe; runtime fallback on self-reported unavailability, error-boundary catch, or
preference broadcast. The boundary offers exactly three actions: retry, switch
engine, copy logs. Every transition emits the now-active renderer. Diagnostics:
500-entry structured ring exportable as one text blob + per-phase timings
(pack / upload / draw / overlay).

## 2. WebGL2 engine

- Vertex shader projects from a `uBounds` uniform (pan/zoom = one uniform write);
  `1e-9` span floor against NaN full-screen triangles; reject non-finite bounds.
  Clip via `gl.viewport` + `SCISSOR_TEST` on the plot rect; round bottom padding up.
- Geometry cache: per series one persistent GPU buffer + reusable staging array,
  interleaved (x,y). Visible window ± **15% guard band**, one extra sample per
  end; sampled signature (length, head, midpoint, last four values, ×6-decimals,
  X + visible Ys) plus an unconditional dirty flag for structural changes.
- Allocation: start 64 floats, double to fit, cap 50,000,000 floats/series,
  shrink only when packed > max(4×need, 4096) *and* need < half packed.
  `bufferData` only on byte-size change; `bufferSubData` with explicit length otherwise
  (per-frame same-size `bufferData` orphans allocations → gigabytes over hours).
- Point markers only below 2 samples/pixel; diameter
  `clamp(10 − 4 × samplesPerPixel, 4, 8)` CSS px; zero guard band for the
  density probe; reuse the line buffer.
- `gl.getError` sampled every ~300 draws (never per frame — it drains the
  pipeline); ~50 consecutive errors or 3 consecutive draw exceptions → fallback.
- Context loss: cancel default, mark unavailable, drop cached handles, **zero
  recorded GPU allocation sizes**, reset counters; rebuild on restore; forced
  re-init at 10 s; 30 s `isContextLost` liveness watchdog; loss budget 3 cycles
  with 60 s stable-render decay; 3 init retries one frame apart; replace a
  poisoned canvas outright.
- **Thick lines are triangle strips from day one** (native line width clamps to
  1.0 on essentially every desktop driver): ~5 floats/vertex (position, offset
  normal, side sign), pixel-space half-width offset after projection, miters
  capped near 4× half-width, degenerates at gaps. Never ship a line renderer
  whose visual weight depends on a driver hint.

## 3. Fallback engine

Canvas2D (uPlot, wrapped) behind the identical handle (callers cannot tell which
engine is mounted). Three behaviors matter more than library choice: series
diffing (never remount on add/remove/hide/recolor), redundant-redraw guard
(epsilon 1e-9, null==null), reshaping fast path (pass-through when shapes match;
NaN-pad to preserve index alignment).

## 4. Axis mathematics

One provisional layout pass breaks the rect↔ticks circularity (nominal 88/48 px
paddings → provisional ticks → measure → final). Label width estimated
arithmetically (`len × fontSize × 0.58`). Edge rules: left
`max(60, ceil(20 + widestYLabel + title))`; right `clamp(ceil(widestXLabel×0.2),
12, 24)`; top 8; bottom `max(32, ceil(14 + xFont + title))`; small-pane (<140 px)
minimums 44/24; skip overlays below 32 px. Ticks: 1-2-5 ladder,
`min(8, floor(px/60))` targets (floor 2, ≥60 px/tick), epsilon on the upper
bound, 20-iteration hard stop, one centered tick for zero span. Exponential
notation at |v| ≥ 1e6 or 0 < |v| < 1e-3; else fixed with
`clamp(ceil(−log10(step))+1, 0, 6)` decimals, trailing zeros stripped.

## 5. Interaction

All math in **plot-rectangle coordinates**. Wheel ×0.85 in / ×1.15 out anchored
at the cursor (never window center); zoom modes X (default) / Y / XY; left-drag
pans from the drag-start viewport + total delta (never accumulated increments);
double-click = Fit All (X to data, Y to window-auto); window-level move/release
binding. Clamping: min X span 0.1 s, min Y span 1e-6; fixed order — substitute
data bounds for non-finite, expand sub-minimum spans about center, **translate**
out-of-bounds windows (never compress mid-drag), hard-clamp, re-check span.
A no-change gesture applies nothing and fires no callback (callbacks disable live
follow). Hover throttled in three stages: ~60 Hz DOM throttle, per-frame
coalescing, snapped-index dedup (skip the entire fan-out if the snapped index and
origin are unchanged).

## 6. Y autoscale

Window-auto (default) fits data inside the visible X window: binary-search the
window (never full history), skip hidden series and non-finite values, pad 10%
with **zero-snapping** (non-negative data never shows a negative axis region;
data crossing zero never snapped), flat signals get `max(|max|×0.10, 1.0)`
centered. Deadband: apply only when a bound moves > `max(0.05, 1% of span)`
against a magnitude scale covering span and bounds; Fit All / mode toggles /
resets / renderer switches bypass with a force flag. Single-entry memo keyed on a
composite signature. Manual-locked freezes Y (user zoom/entry); Fit All returns
to window-auto.

## 7. Live mode and render loop

Exactly one rAF loop per plot component; engines draw only inside handle calls.
Frame budget 16 ms, degrading to 33 ms once
`visiblePoints × seriesCount ≥ 200,000` (halve the rate, never the data).
Live off = loop body returns immediately; acquisition continues. Zoom/pan
auto-disables live follow; re-enabling snaps to newest preserving window width.
Push dedup on length + last timestamp + series count + 4-sample tail signature,
**with recorded skip reasons** (unchanged / no data / all hidden / live off).
Windowed fetch: live window (default 300 s, min 5 s) or explicit range + 15%
guard, clamped; one recovery path — an empty windowed result with live on and
signals assigned refetches unwindowed that tick (log ≤ 1/5 s). Throttles:
interaction bounds 250 ms; window-auto refit 120 ms or on data change; legend
10 Hz; hover ~60 Hz; spectrum 100 ms. **The loop reads refs, never framework
state**, and the loop-start effect excludes viewport state from its deps (both
halves required); interaction handlers write the ref first; the active renderer
identity stays a dependency.

## 8. Multi-pane

One or two stacked panes with a draggable divider; per-pane signal assignment,
Y axis/mode, legend; drag between panes; model the pane list as a general array;
collapsing **merges** assignments (dropping them is data loss). Persist layout /
assignments / colors / split on a 500 ms debounce gated behind restore-complete.
**One shared X range across panes** (the entire point of stacking); Y, live
follow, autoscale stay per-pane. Cursor sync through a small external
subscribe/snapshot store — origin tag + applying-guard flag against echo and
re-entrant loops; setter short-circuits on equal values; shared X range uses the
same publisher-tag discipline and clears live follow in receiving panes. Readout
isolation: only the time chip and value cells subscribe. One ring buffer per
signal shared across panes; pane data is a projection. CSV export of the visible
window (timestamp first, one column per visible signal, units in header) — the
visible window *is* the selection.

## 9. Frequency-domain view (FFT)

Reuses the same chart stack (X in Hz, Y in dB). Recompute on a fixed 100 ms timer
independent of the render loop, gated on tab visibility. Pipeline: sample-rate
estimate = 1 / median positive delta over ≤ 512 timestamps; zero-order-hold
resample onto N uniform samples ending at the newest timestamp (single advancing
index); Hann window; in-place radix-2 Cooley-Tukey over separate real/imaginary
f64 arrays; one-sided magnitudes scaled 1/N at DC and Nyquist, 2/N between,
floored at 1e-20 before `20·log10`. N selectable 256–4096 (clamped down to a
power of two, hard cap 65536 programmatically); display fs/N resolution and N/fs
span beside the selector. dB axis uses an **asymmetric hold**: expand instantly,
contract by exponential decay ~3%/s (`held = fit + (held − fit) × exp(−0.03·dt)`);
reset held range on transform-size / rate-mode / signal-set changes + manual
reset. Detachable picture-in-picture panel through a root-level portal
(geometry: [SRS_visual_ui.md](SRS_visual_ui.md) §5.1). **One compute module, one
result object, two thin mounts** — compute once, render twice.

## 10. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| GR-001 | Plot every sample in the visible window with no decimation, bucketing, stride sampling, or envelope reduction | Must | Planned | With 1,000,000 in-window samples, drawn vertex count equals in-window sample count; a single-sample spike renders at full amplitude at every zoom level containing it |
| GR-002 | Data ownership, viewport policy, autoscale above the engine layer; one identical handle across engines | Must | Planned | One conformance suite passes unmodified against both engines; same plot rect and ticks within 1 px for identical input |
| GR-003 | Default to GPU, fall back automatically when WebGL2 is unavailable or fails | Must | Planned | With WebGL2 disabled, a chart renders within 1 s of mount, no modal error, active-renderer event reports fallback |
| GR-004 | Clip-space projection from a bounds uniform; clip to plot rect | Must | Planned | Viewport change with unchanged data → zero buffer uploads; no series pixel outside the rect at DPR 1.0/1.25/1.5/2.0 |
| GR-005 | Reallocate only on size change; 50M-float cap/series; hysteresis shrink | Must | Planned | Over 1 h at 60 Hz, post-warm-up reallocations equal capacity changes and memory grows < 10%; above-cap requests refused with a logged error, no crash |
| GR-006 | Context-loss recovery ×3 then permanent fallback; 10 s forced re-init; 30 s watchdog | Must | Planned | Three forced losses each recover within 10 s; the fourth falls back; a silent loss detected within 30 s |
| GR-007 | Strokes wider than 1 px via triangle geometry | Must | Planned | A 3 px stroke measures 3 device px ± 1 on a driver clamping native width to 1.0 |
| GR-008 | Error boundary with retry / switch / log export | Must | Planned | Engine exception shows the panel, app stays interactive, export yields the last 500 entries including the fatal stack |
| ZM-001 | Wheel ×0.85/×1.15 on mode-selected axes, cursor-anchored, plot-rect coords | Must | Planned | One notch changes span within 0.1%; after 10 notches the value under the pointer stays within 1 px |
| ZM-002 | Min spans 0.1 s (X) / 1e-6 (Y); shift not compress at bounds; no-op gestures apply nothing | Must | Planned | Zoom-in halts at minimum; window width unchanged within 1e-9 when panning past the first sample; wheeling at the clamp keeps live follow |
| ZM-003 | Hover: ~60 Hz throttle, frame coalescing, snapped-index dedup | Should | Planned | At 1 kHz synthetic input ≤ 60 emissions/s and ≤ 1/frame; no-index-change travel → zero notifications |
| AS-001 | manual_locked and window_auto modes; explicit Y set switches to locked | Must | Planned | Locked bounds unchanged after 10,000 appends; Y zoom locks; Fit All restores auto |
| AS-002 | Window-auto scans only in-window samples via binary search, skipping hidden series | Must | Planned | Out-of-window outliers don't change the range; scan cost scales with visible samples |
| AS-003 | 10% pad with zero-snapping; flat-signal span max(\|max\|×0.10, 1.0) | Must | Planned | Non-negative series never shows a bound below zero; constant series renders centered |
| AS-004 | Deadband max(0.05, 1% of span) per bound | Must | Planned | Sub-1% drift → unchanged range and labels over 60 s |
| LM-001 | One rAF loop per plot; engines draw only in handle calls | Must | Planned | One callback per mounted plot; no draw outside handle calls |
| LM-002 | 16 ms budget → 33 ms at 200k points×series; no chart work with live off | Must | Planned | Threshold crossing → 33 ± 2 ms with unchanged drawn count; live off → < 0.1 ms/frame, no gap on resume |
| LM-003 | Push dedup by length/timestamp/count/tail; fetch window + 15% guard | Must | Planned | Static data → zero engine data calls over 600 frames with recorded reason; fetch ≈ window + 30% regardless of history |
| LM-004 | Loop inputs via refs; start effect independent of viewport | Must | Planned | 100 wheel notches during streaming → zero loop restarts, zero viewport reversions |
| MG-001 | ≤ 2 stacked panes, drag-and-drop assignment, one shared X range | Must | Planned | Cross-pane drag lossless; collapse merges; zoom updates all panes same frame |
| MG-002 | Cursor sync via external store without echo | Must | Planned | Pane-A cursor appears in pane B within one frame; exactly one publish per gesture |
| MG-003 | Cursor motion re-renders only chip and cells; one shared buffer per signal | Must | Planned | Chart/toolbar/list render counts unchanged across 100 moves; two-pane memory within 5% of one |
| MG-004 | Per-pane CSV export of the visible window with units | Should | Planned | Row count = visible samples; header has one column per visible signal with unit |
| FF-001 | Reuse the chart stack; 100 ms recompute gated on visibility | Must | Planned | Same engine handle; hidden tab executes zero transforms over 60 s |
| FF-002 | Median-delta fs over ≤ 512 stamps; ZOH resample; Hann; radix-2; N 256–4096 pow2, cap 65536 | Must | Planned | 100 Hz stream with a 5 s gap → fs within 1%; 50 Hz sine at 1 kHz, N=1024 → peak within one bin; non-pow2 clamps down |
| FF-003 | One-sided scaling 1/N (DC, Nyquist), 2/N elsewhere; 1e-20 floor | Must | Planned | Peak within 0.5 dB of documented scaling; all-zero input finite near −400 dB, no NaN/∞ |
| FF-004 | Expand instantly, contract ~3%/s exponential decay | Must | Planned | Step reflected within one update; 95% of gap closed in ~100 s after source removal; no oscillation |
| FF-005 | Detached panel via root portal, persisted clamped geometry, one compute module | Must | Planned | View switches don't destroy the panel; off-screen positions clamp on load; both views read one result |
