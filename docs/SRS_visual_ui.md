# SRS — Visual and UI

**Scope:** The visual identity of RadEAU and the composition of every view —
color, type, spacing, geometry, control inventory. Appearance only; behavior
lives in [SRS_graphing.md](SRS_graphing.md), [SRS_streaming.md](SRS_streaming.md),
and [PRD.md](../PRD.md). **Every number here is normative.** ID prefix: `VU-`.

---

## 1. Design language

RadEAU is an **engineering instrument**, not a dashboard: users watch it for
hours while a network runs, reading dense numeric detail at a glance. Four
principles follow; every rule below applies one of them.

1. **Dark-first, single theme.** One theme ships. No light mode, no switch;
   contrast targets are met inside the dark palette rather than deferred to a
   second one.
2. **Flat surfaces.** Depth is a three-step surface ramp plus 1 px borders —
   never gradients or decorative shadow. Component libraries that tint panels by
   nesting depth shall have that disabled globally, so a panel reads at one
   luminance wherever it sits. Shadow is permitted only where something
   genuinely floats: the picture-in-picture window and toasts.
3. **Color is reserved for data and state.** Chrome is achromatic; the most
   saturated pixels on screen are the signal traces. When eight series are
   plotted, hue alone distinguishes them, and decorative color anywhere else
   competes for that discrimination budget. A second reservation covers state —
   recording, error, warning and success each own one hue and use it nowhere
   else.
4. **Density over comfort.** Toolbars are 48 px, not 64. Rows are compact.
   Controls are icon-only wherever the icon is unambiguous, the label carried by
   a tooltip. Screen budget goes to rows and pixels of plot.
5. **Only true information.** Every dynamic value on screen derives from real
   core data — live traffic, real session state, real link state. No view
   fabricates activity: where the data source does not exist yet, the view
   shows an honest empty state naming what it is waiting for, never a mock
   that looks alive. Static layout scaffolding is fine; fake numbers are not.

## 2. Color tokens

This palette is the **single source of truth**: declare it once as custom
properties on the document root, mirror it into the MUI theme, and never write a
color literal inside a component. Enforce with a lint rule that fails the build
on any hex outside the token module. (Prior art shipped ~95 scattered hex
literals and the palette drifted — two different error reds eight pixels apart.)

### 2.1 Surfaces and lines

| Token | Value | Applies to |
|---|---|---|
| surface-canvas | `#0d1117` | Window background, view content region, plot background, startup overlay |
| surface-raised | `#161b22` | App bar, nav rail, panels, dialogs, PiP body, toast body |
| surface-raised-2 | `#21262d` | PiP title bar, sticky table headers, strips nested in a raised panel |
| border | `#30363d` | All 1 px rules: panel edges, app bar underline, row separators, splitters |
| border-hairline | `rgba(255,255,255,0.18)` | Input outlines at rest |
| border-hairline-hover | `rgba(255,255,255,0.30)` | Input outlines on hover |
| fill-subtle | `rgba(255,255,255,0.04)` | Input interiors, expanded rows, hover wash, active toggle fill, drop target |
| scroll-thumb | `#30363d` | Scrollbar thumb; 10 px track, square corners, transparent track |
| scroll-thumb-hover | `#484f58` | Scrollbar thumb, hover |

### 2.2 Text

| Token | Value | Applies to |
|---|---|---|
| text-primary | `#e6edf3` | Body copy, cell values, control labels, headings |
| text-secondary | `#8d96a0` | Captions, units, helper text, inactive icons, pane titles |
| text-tertiary | `#8b949e` | Log timestamps, resize grips, passive marks |
| text-on-plot | `#ffffff` | Axis tick labels, axis rules, cursor dot ring — the only pure white |
| text-disabled | — | `text-primary` at 38% opacity; never a separate hex |

### 2.3 Accent and semantic

| Token | Value | Applies to |
|---|---|---|
| accent-primary | `#5090ea` | Selected nav item, active toggle, focus ring, cursor readout, default toast rule |
| accent-secondary | `#8b5cf6` | Second interactive dimension; transmitted-frame token |
| info | `#58a6ff` | Replay indicators, received-frame token, default series stroke |
| success | `#3fb950` | Start action, connected state, loaded-catalog badge |
| warning | `#d29922` | Paused and armed states, degraded conditions, uncommitted edits |
| error | `#f85149` | Stop action, active recording, error stream, close-button hover |

Each semantic token carries one `-dark` variant, roughly 20% darker, used only
for filled-button hover. No other tints exist; a softer error is `error` at
reduced opacity, not a new hex.

### 2.4 Chart chrome

| Token | Value | Applies to |
|---|---|---|
| plot-grid | `#2c3239` | 1 px grid lines spanning the plot box, both axes |
| plot-tick | `#7f8791` | 5 px tick marks outside the plot box |
| cursor-primary | `rgba(255,255,255,0.60)` | Vertical crosshair |
| cursor-secondary | `rgba(255,255,255,0.35)` | Horizontal crosshair |

### 2.5 Series palette

Sixteen ordered hues. A new signal takes the **first color not currently in
use**; if all sixteen are taken it falls back to index `(count mod 16)`.
Assignment is deterministic and reclaimable — remove the third signal and the
next one added takes its color back — so a user who habitually plots the same
four signals sees the same four colors every session. Colors are never hashed
from names and never randomized.

| # | Value | # | Value |
|---|---|---|---|
| 1 | `#58a6ff` | 9 | `#a371f7` |
| 2 | `#8b5cf6` | 10 | `#79c0ff` |
| 3 | `#3fb950` | 11 | `#ff9bce` |
| 4 | `#f85149` | 12 | `#ffd33d` |
| 5 | `#d29922` | 13 | `#7ee787` |
| 6 | `#db6d28` | 14 | `#ffa657` |
| 7 | `#2ea043` | 15 | `#c9d1d9` |
| 8 | `#ff7b72` | 16 | `#56d4dd` |

The first four are maximally separated in hue, covering the common
two-to-four-signal case unambiguously. Positions 1–4 deliberately coincide with
`info`, `accent-secondary`, `success` and `error` — intentional reuse that keeps
the on-screen hue count low.

## 3. Typography

One sans stack for the interface, one monospace for machine data, both
**bundled with the application** rather than referenced by name and hoped for:
`font-ui` is `Roboto, "Segoe UI", system-ui, sans-serif`; `font-mono` is
`"Roboto Mono", Consolas, monospace`. If a layout depends on a font's metrics,
that font is a build artifact, not a preference (prior art measured text against
one face and rendered another; panels were consistently a few pixels wrong).

| Role | Size | Weight | Stack | Color |
|---|---|---|---|---|
| App wordmark | 20 px | 500 | ui | text-primary |
| Navigation label | 16 px | 400 | ui | text-primary |
| Panel / section header | 14 px | 500 | ui | text-primary |
| Body, form labels, table cells | 14 px | 400 | ui | text-primary |
| Caption, units, helper text | 12 px | 400 | ui | text-secondary |
| Legend signal name | 11.2 px | 700 | ui | series color |
| Legend unit | 9.6 px | 400 italic | ui | text-secondary |
| Cursor time readout | 11.2 px | 700 | ui | accent-primary |
| Axis tick label | 11 px | 400 | ui | text-on-plot |
| Axis title / pane title | 12 px | 400 / 500 | ui | text-on-plot / text-secondary |
| Payload bytes, identifiers, timestamps, live values | 13 px | 400 | mono | text-primary |
| Console output | 14 px | 400 | mono | text-primary / error |
| Console timestamp, crash detail | 12.5 px | 400 | mono | text-tertiary |
| Startup overlay label | 13 px | 400 | ui | text-primary, uppercase, 0.08em tracking |

Monospace marks **machine data whose column alignment carries meaning** —
payload bytes, identifiers, timestamps and deltas, live values, build strings —
and is forbidden for prose, labels and headings. Every numeric column and
readout sets `font-variant-numeric: tabular-nums`; a value changing 60 times a
second must not shift its neighbors.

Formatting is fixed-decimal, not significant-figure: timestamps and deltas to
4 decimals, scaled values to 4, live legend values to 2, identifiers as `0x`
plus uppercase hex zero-padded to the field's digit count (service and method
ids to 4 digits), payload as space-separated two-digit uppercase hex. Zero
renders `0.0000`, never `0` — ragged decimal points are what tabular numerals
exist to prevent.

## 4. Window and shell

### 4.1 Frameless window

The application runs **undecorated** and draws its own title bar into the app
bar, so the top 48 px is product surface. Three consequences must be explicit:
the app bar is a **drag region**, and every interactive child opts out and stops
pointer-down propagation so a click never starts a window drag. Window controls
sit at the far right — minimize, maximize/restore, close — each a 24 px icon
button with 4 px padding and 4 px radius; close is the only one with a colored
hover (background `error`), and maximize is a 16 px outline square that becomes
a 14 px offset-squares glyph when maximized. Default window size is
**1440 × 900** logical px with a hard minimum of **1024 × 700** (the minimum is
the width the app bar needs; enforce it in the window configuration).

### 4.2 Layout map

```
┌───────────────────────────────────────────────┐
│ APP BAR                            48 px      │  surface-raised
├──────┬────────────────────────────────────────┤  1 px border
│ NAV  │ REPLAY BAR (conditional)   40 px       │
│ RAIL ├────────────────────────────────────────┤
│ 65 / │ VIEW CONTENT                           │  surface-canvas
│ 240  │ padding 24 px (0 for full-bleed views) │
└──────┴────────────────────────────────────────┘
```

### 4.3 App bar

Height 48 px, `surface-raised`, 1 px bottom border, stacked above the nav rail.
Contents left to right:

| # | Control | Icon | Specification |
|---|---|---|---|
| 1 | Rail toggle | Menu | Icon button, edge-aligned, 16 px right margin |
| 2 | Product mark | — | 40 px tall, 12 px right margin, non-draggable, pointer-events none |
| 3 | Wordmark | — | 20 px / 500, no wrap, 16 px right margin |
| 4 | Autosave toggle | Save | `accent-primary` on, `text-secondary` off; tooltip states resulting state |
| 5 | Session title field | — | Centered in remaining space, 300 px, small outlined, `fill-subtle` interior, placeholder 60% opacity, 300 ms debounce |
| 6 | Record indicator | RadioButtonChecked | 16 px: `text-secondary` idle, `warning` armed, `error` recording |
| 7 | Record switch | — | Small, track and thumb `error` when checked, disabled in replay; arms continuous pcap recording (SRS_capture §7): armed while stopped stores the intent, the file opens with the next session; the indicator shows `warning` while armed and `error` only while bytes are actually being written — never for a recording that is not happening |
| 8 | Run control | PlayArrow / Stop | Filled: `success` live start, `info` replay start, `error` running; icon and label both change; 60% opacity disabled |
| 9 | Window controls | Remove / CropSquare / Close | As §4.1 |

**The run control owns the session.** Starting it is the one trigger that
begins reading frames from the selected interface and processing them; stopping
it halts the session everywhere. While stopped, nothing anywhere in the app
displays or updates dynamically — no view animates, streams, or refreshes.
View-local start/stop affordances (the Trace rail's capture button) are
mirrors of this same session state, never independent sessions. The selected
interface (dev generator, simulator link, later a physical NIC) is session
configuration, editable only while stopped, and lives in the Settings view's
Interface group (§5.7) — never as a control strip on a data view. Data views
surface interface *state*, not interface *choice*: while a session runs on a
degraded link (connecting, reconnecting, error), Trace shows a small outlined
chip in the same top-right slot family as the paused chip; a healthy link
shows nothing.

### 4.4 Navigation rail

A permanent left drawer, 65 px collapsed and 240 px expanded, `surface-raised`,
1 px right border, horizontal overflow hidden. Width animates on a sharp curve
over 225 ms — the one motion that survives §8, because it is user-initiated,
rare, and never runs during data flow.

Entries are 48 px tall with 20 px horizontal padding. Collapsed, the icon
centers and the label sits at zero opacity — present in the accessibility tree,
invisible on screen; expanded, the icon is left with 24 px before the label.
Tooltips appear to the right **only when collapsed**, never duplicating a
visible label. The selected entry takes a `fill-subtle` wash with an
`accent-primary` icon and label, plus `aria-current`.

| Order | Entry | Icon |
|---|---|---|
| 1 | Trace | Terminal |
| 2 | Signals | Waves |
| 3 | Network | Hub |
| 4 | Recorder | RadioButtonChecked |
| 5 | Simulation | Send |
| 6 | Automation | Code |
| 7 | Protocols | Shuffle |
| 8 | Settings | Settings |
| pinned | About | Info — bottom of rail, separated by a flexible spacer |

About opens a small modal: product mark, name, one-line description, and a
two-column grid giving build tag and commit hash in `font-mono`. Entries may be
hidden by a low-overhead operating mode; when the active view is one of them,
navigation falls back to Trace rather than leaving the content region blank.
(View inventory per [PRD §3.7](../PRD.md); Protocols stays hidden until it
ships.)

### 4.5 Content region

A vertical flex column: app-bar spacer, optional replay bar, then the view
container at 24 px padding — except Signals, which runs full-bleed because its
own panels supply the edges. Views stay mounted and are hidden with
`display: none` rather than unmounted, so graphics contexts and scroll positions
survive navigation. One visual consequence: **a hidden view reports zero size**,
so layout math running while hidden must be guarded, or a chart paints one frame
of stretched, oversized axis labels when revealed.

## 5. Per-view composition

### 5.1 Signals

The primary analysis surface. Three regions across the width, separated by 1 px
`border` rules, with no outer padding.

| Region | Width | Contents |
|---|---|---|
| Source explorer | Auto-fit 300–520 px, 50 px collapsed | Tree of decodable services, events, and signals; drag sources |
| Legend panel | Auto-fit 180–420 px | Plotted signal list, cursor readout |
| Plot stack | Remaining, minimum 320 px | One or two chart panes |

Explorer width is measured from its widest label at 13 px plus 140 px of
chrome, clamped to [300, 520]; its header carries a format toggle group, the
pane-split toggle and a collapse chevron, and collapsed it becomes a 50 px icon
rail keeping the split toggle reachable. Above the plot stack sit two tabs,
**Time** and **FFT**, 36 px tall with an 8 px inset and a 1 px bottom rule;
both panels stay mounted.

**Plotter toolbar.** One row, 8 px padding, 8 px gaps, 1 px bottom rule,
full-height 1 px dividers between clusters. Every control is icon-only with a
tooltip; active toggles take an `accent-primary` glyph over a `fill-subtle`
fill; unavailable controls are disabled with a tooltip naming the precondition,
never hidden.

| Cluster | Controls, in order | Icons |
|---|---|---|
| Transport | Title, pause/resume | Pause / PlayArrow, `warning` when paused |
| Zoom mode | X only, Y only, both — exclusive group, default X | SwapHoriz, SwapVert, OpenWith |
| View | Fit all, window autoscale, shared cursor, live follow, sample markers | FitScreen, CropFree, Link, Autorenew, ScatterPlot |
| Session | Clear, reset renderer, export | DeleteSweep, RestartAlt, Download |
| Config | Settings menu — 250 px, two switches, two numeric fields with helper text | Settings |
| Renderer | Active-renderer chip, 22 px outlined, `info` when accelerated; then preference group | text labels |
| Layout | Legend panel visibility | ViewSidebar |

**Legend panel.** Width is computed: measure the widest signal name at 11 px,
add 120 px for toggles, remove button and padding, clamp to
`[180, min(420, containerWidth − 320)]`, persist. With no signals it is exactly
180 px. The header is two rows — a `Signals (n)` caption with the cursor
readout right-aligned beside it, then a right-aligned pair of 14 px toggles for
panel visibility and cursor values.

The list is virtualized at a **fixed 48 px row height** (a virtualized list
shall declare a constant row height; per-row measurement is a per-frame layout
cost on the hot path). A row carries no separate color chip: the color is
carried by the name itself, the densest encoding available at this width. Line
one is a small visibility switch, a 14 px spectrum toggle, the name at
11.2 px / 700 in the series color with ellipsis overflow, and a 14 px Close
button. Line two, indented 36 px to align under the name, is the live value at
11.2 px / 700 in `text-primary`, a dimmed pipe, the cursor value in
`accent-primary`, and the right-aligned unit at 9.6 px italic. Absent values
render `--`, never a stale number.

**Panes.** Split view stacks two panes at equal flex share, separated by a 2 px
`border` rule that doubles as the resize grip (4 px hit area, `row-resize`
cursor); no gap. Each pane owns its toolbar, axes and cursor. Signals move
between panes by dragging a legend row: the source renders at 40% opacity with
a `grab` cursor and the target washes to `fill-subtle`. Disabling split merges
pane two into pane one. The cursor readout — `@12.34s` in `accent-primary` —
lives in the legend header and is the only element that re-renders on cursor
movement. Empty state: `Drag signals here to plot` at 13 px `text-secondary`,
inset 12 px from the pane's top-left with pointer events disabled, covering
neither the axes nor the drop target.

**FFT tab.** Three columns: a 260 px configuration rail, a 200 px
enabled-signal panel, and the spectrum chart. The rail holds a header with a
detach button, an auto-sample-rate switch, a numeric rate field (disabled while
auto, helper text reporting the estimate), transform-length and window-function
selects, a reset-Y button and a peak-frequency caption. Signal rows are a 10 px
circular dot, the name at 11.2 px / 700 in the series color, the cursor
magnitude at 10.4 px in `text-secondary`, and a 12 px remove glyph. The chart's
cursor readout is a small chip pinned 8 px from the top-right, labelled
`<freq> Hz · <mag> dB`. Spectrum series stroke at 1.5 px — thinner than
time-domain series, because a spectrum packs more detail per pixel.

**Picture-in-picture.** The spectrum detaches into a floating window portaled
to the document root, above all view content. Default 440 × 300 at offset
(48, 96); minimum 280 × 180; clamped so at least 64 px stays on screen;
persisted. A 36 px title bar in `surface-raised-2` with a 1 px bottom border
carries an 18 px drag glyph, the title at 12 px / 600 and a close button, and
is itself the drag handle with a `move` cursor. The body is `surface-raised`
with a 1 px border; the chart is inset 8 px, floored at 120 × 80. A 14 × 14 px
bottom-right grip is a diagonal `text-tertiary` stripe with an `nwse-resize`
cursor.

### 5.2 Trace

A full-height virtualized table with a 50 px vertical control rail on its left
edge — raised surface, 1 px right border, 16 px top padding, five icon buttons
at 40 px pitch with right-placed tooltips: display settings, load service
catalog (badged with a 6 px `success` dot when loaded), pause/resume, clear,
and export buffered frames as pcap (Download glyph; disabled with the reason
"no frames buffered" when the frame ring is empty; the save dialog defaults
to `radeau-<session start>.pcap`; SRS_capture §3). There is no horizontal
toolbar; filtering is per column.

The catalog rail button opens a 300 px popover: the active source (file name,
or "embedded demo catalog"), service and signal counts, the actions **Import
ARXML…** (file dialog, `.arxml`), **Reload**, and a **Decode** switch (the
former load/unload toggle), then the import diagnostics list — severity glyph,
element path in `font-mono`, message — capped at 250 px with an
`errors / warnings` count and an honest "no diagnostics" line. The badge dot
is `success` when the catalog decodes cleanly, `warning` when it decodes with
diagnostics, and `error` when the last import failed — in which case the
popover states that the previous catalog stays active and shows the error
verbatim (SRS_protocols §4).

Columns (formatting rules — zero-padded uppercase hex, 4-decimal seconds,
right-aligned numerics, mono for machine data — are inherited unchanged; the
column set serves the Ethernet frame model of PRD §3.4):

| Column | Width | Align | Face and format |
|---|---|---|---|
| Expand | 40 px | center | chevron glyph |
| Time | 120 px | right | mono, 4 decimals, seconds |
| Direction | 70 px | left | ui, colored token |
| Source | 90 px | left | ui |
| Protocol | 90 px | left | ui token (SOME/IP, SD, gPTP, …) |
| Service:Method | 130 px | right | mono, `0x` + zero-padded uppercase hex pair |
| Name | 200 px | left | ui, ellipsized |
| Type | 70 px | left | ui token |
| Session | 70 px | right | mono |
| Length | 70 px | right | mono |
| Payload | 300 px | left | mono, space-separated uppercase byte pairs |
| Δ global | 100 px | right | mono, 4 decimals |
| Δ per key | 100 px | right | mono, 4 decimals |
| Channel | 50 px | right | mono |
| Pin | 44 px | center | fixed mode only |

Row height is a fixed **32 px**. No zebra striping — a 1 px `border` bottom
rule only, because striping fights the state coloring; hover applies a
`fill-subtle` wash. The header is sticky on `surface-raised-2` at 14 px / 500
with 8 px padding. Each column has a 4 px right-edge drag handle, `col-resize`
cursor, `accent-primary` on hover, 50 px minimum; widths persist. Direction
carries a text token as well as a color — `info` received, `accent-secondary`
transmitted, and "—" in `text-secondary` when the source cannot know the
direction (never a guessed Rx). Malformed frames set the offending cells to
`error`.

**Every frame is a row** (SRS_protocols §2): the Protocol column carries one
of the tokens `SOME/IP`, `SD`, `gPTP`, `ARP`, `UDP`, `TCP`, `ICMP`, `IPv6`,
`IPv4`, `Other`, `DoIP`, `Malformed`, plus the standard-protocol tokens of
SRS_protocols §7 (`ICMPv6`, `IGMP`, `DHCP`, `DNS`, `NTP`, `SSDP`, `PTP`,
`LLDP`, `AVTP`, `MACsec`, `EAPOL`, `HTTP`, `TLS`, `SSH`, `SCTP`, `TFTP`,
`SNMP`) whose Name / Type and fixed-mode keys are the §7 table — an unknown
class code renders `Unknown (n)`, never a default protocol. Per class, Name
and Type read:
SOME/IP — catalog name, Type Notification / Request / Request-no-return /
Response / Error; SD — the first entry kind (Offer, Find, StopOffer,
Subscribe, StopSubscribe, SubscribeAck, SubscribeNack), Name
`<kind> · <source>`; gPTP — Type Sync / Follow_Up / Pdelay_Req / Pdelay_Resp /
Pdelay_Resp_Follow_Up / Announce / Signaling, Name `<Type> · <source>`;
ARP — Type Request / Reply, Name `who-has <ip>` / `<ip> is-at`; UDP and TCP —
Name `<src ip>:<port> → <dst ip>:<port>`; ICMP — Name `type <t> code <c>`;
IPv6 — Name `next header <n>`; IPv4 — Name `protocol <n>`; Other — Name
`EtherType 0x….`; Malformed — Name `runt · <n> bytes`, Protocol cell in
`error`; DoIP — Name the payload-type name ("Vehicle Announcement",
"Routing Activation Request", "Diagnostic Message", …), Type the UDS
service name for diagnostic messages (`TesterPresent`, `ReadDataByIdentifier
response`, `NRC` for 0x7F) and `--` otherwise. Service:Method shows the
SOME/IP pair for SOME/IP and SD, ports for UDP/TCP, `0x<src> → 0x<tgt>`
logical addresses for DoIP diagnostic messages, and `--` otherwise. The
Payload column previews from the payload offset the core supplies (VLAN tags
never shift it).

Two modes share the table. **Sequential** appends chronologically and
auto-follows the tail while scrolled to the bottom. **Fixed** collapses to one
row per (service, method) key — pinned first, then key ascending — rewriting
rows in place, so the per-key delta becomes a live cycle-time readout and a pin
column appears. Rows without a service identity key by (protocol, source
address) instead — SD offers keep one row per emitting node, gPTP one row per
(node, message type) so Sync and Announce show their own cadences, ARP one row
per node, UDP and TCP one row per flow (src address:port → dst address:port),
ICMP one per (src, dst), IPv6 / IPv4 / Other one per (source MAC, next
header / protocol / EtherType), Malformed one per source MAC, DoIP one row
per (source address, payload type) for discovery and status messages and
one per (source → target, UDS service with the response bit folded) for
diagnostic messages so a request and its response share a live row and
TesterPresent shows its cadence — never a single row that hides a class. Δ
per key follows the same keying. **Fixed is the default mode**: the
steady-state picture of the network is the first thing an operator needs, as
with a CAN trace keyed by arbitration id. Mode, history window and column
order live in the settings panel rather than on screen, being set once per
session.

The Service:Method, Name, Protocol and Direction columns offer filtering
through a header glyph that tints `accent-primary` while active, opening a
250 px popover: search field (omitted for the small fixed value sets of
Protocol and Direction), a select-all/deselect-all button paired with a
`selected / total` count, a checkbox list capped at 250 px, and Cancel/Apply.
Selecting everything clears the filter rather than storing a no-op; filters
apply on Apply, not per checkbox. Values are the distinct values present in
the buffered ring; Service and Name selections are keyed by (service, method)
ids so a catalog load mid-session renames rows without invalidating the
selection. Filtering is a projection over the untouched ring — never an
ingest filter — and runs **before** the mode projection: Fixed shows the
latest *matching* frame per key, Sequential's history window holds the last N
*matching* rows. Pinned keys do not bypass filters. While any filter is
active a `Filtered · shown / total` chip joins the top-right chip family, the
empty state reads "No rows match the active filters" when the ring is not
empty, and applying a filter clears the row expansion the way a mode change
does. The paused chip's buffered count stays the raw ingest count. Filters
are session-scoped, like mode and pins.

Any row expands to a **protocol-layer dissection** on `fill-subtle`, indented
48 px — the Wireshark model. One collapsible section per layer in wire order
(Ethernet II → IPv4 → UDP → SOME/IP → SOME/IP-SD entries, or
Ethernet II → gPTP), each headed by the protocol name and a one-line summary,
its fields as name/value rows at 28 px in `font-mono` values, ordered as on
the wire. The final section is the payload: hex bytes in 16-byte rows with
offsets. When the service catalog is loaded (v0.5), the SOME/IP payload
section becomes the decoded five-column table — name, raw hex, raw decimal,
scaled value, unit, proportioned 32 / 18 / 18 / 22 / 10%, data columns
right-aligned `font-mono`. Dissection is fetched from the core on demand when
a row expands (a cold path — never part of the streaming batch); a frame
evicted from the core's bounded frame buffer states that honestly ("frame no
longer buffered") instead of showing a partial view.

The paused state shall show three simultaneous changes: the rail button swaps
glyph and takes the `warning` tint, a `warning`-outlined chip reading
`Paused · n buffered` appears at the table's top-right, and a 2 px `warning`
rule appears along the table's top edge. Pause is a mode, and modes need an
indicator inside the region they affect.

The same top-right chip family carries a `warning`-outlined `Dropped · n`
chip whenever any loss counter of the running session is non-zero
(accumulator drops, gap-dropped frames, kernel drops — the tooltip breaks
them down, from `capture:stats`); a session with no loss shows no chip. A
trace that understates the wire is never silent about it. While a pcap
recording is active (SRS_capture §7) the same family shows an
`error`-outlined `Recording · n frames` chip whose tooltip names the file —
the region being recorded says so itself (VU-015).

### 5.3 Recorder

A single column of panels, each 24 px padded on `surface-raised` with a 1 px
border, 32 px apart, capped at 800 px, each opening with a colored icon beside
a 20 px / 500 title over a full-width divider. **Record**: arm switch, a
disabled directory field paired with a Browse button, a 12 px caption naming
the default location, and — while capturing — the active file path in a
disabled `font-mono` field with a Copy button. **Replay**: mode switch,
disabled source-path field, and a split button whose main action browses and
whose caret lists the five most recent captures as basename over ellipsized
path. The recording panel takes a static 3 px `error` left rule while
capturing, never a blinking one.

The Record panel is the pcap recording of SRS_capture §7: the arm switch
mirrors the app-bar record switch (one state), the directory field shows the
recordings directory with a Browse button (`recording_dir_set`, locked while
a recording is active) and a 12 px caption naming the default location; while
a recording is active the panel shows the file path in a disabled `font-mono`
field with a Copy button and live `frames · bytes · dropped` counters from
`recording:state`; a write error appears as an inline `error` alert and
disarms the switch. The recent-recordings list holds only true files from
`recording_list()` (basename over ellipsized path, bytes, frame count when
known), newest first, with the honest empty state "no recordings yet". The
panel also keeps **Export buffered frames** (the same action as the Trace rail
button, with the buffered frame count beside it). The Replay panel's
source-path control opens a `.pcap` / `.pcapng` file (a recording from the
list can be replayed the same way) and sets the Interface to the pcap source
(SRS_capture §2) — replay for the bench prototype build, honest about being file
playback through the capture path. The JSONL recording with decoded names
and the paced replay worker remain v0.6.

### 5.4 Simulation

A secondary navigation rail plus a content pane, reusing the primary rail's
65 / 240 px geometry, tooltip-when-collapsed rule and 1 px right border so the
two read as one system. Its header pairs a 20 px / 500 `text-secondary` title
with a chevron above a divider; four entries cover node simulation, signal
simulation, frame generation and stored presets. The content pane scrolls
independently at 24 px padding. Signal value controls pair a slider with a
numeric field, the field authoritative and the slider a coarse input; slider
value tooltips are prohibited and the thumb, track and rail carry no
transitions (§8).

Until the simulation core lands (v0.7) the view keeps its secondary rail and
shows an honest empty state per entry ("node simulation arrives v0.7", and so
on) — no mock signal controls that do nothing (§1 principle 5).

### 5.5 Automation

Two panels side by side, 16 px gap and 16 px outer padding: a 300 px script
list and a flexible console. List rows show file name over ellipsized path at
12 px, with run/stop (`success` / `error`) and delete as trailing actions; a
running script's name switches to `accent-primary` at weight 700. The console
is `surface-canvas` under a `surface-raised` header strip carrying a monospace
title and a clear button; output is `font-mono` at 14 px, 1.5 line height,
16 px padding — a non-selectable 12.5 px timestamp in `text-tertiary` with
16 px right margin, then the message in `text-primary`, or `error` for the
error stream. Lines wrap, long tokens break, the view follows the tail.

Until the automation surface lands (v0.7.1) the script list is the empty
state "no scripts — automation surface arrives v0.7" and the console carries
no fabricated output; the run/stop/delete actions do not appear.

### 5.6 Protocols

A tabbed workspace, one tab per higher-layer protocol, the bar on
`surface-raised` at 16 px inset over a 1 px rule with an `accent-primary`
indicator. Unimplemented protocols appear as disabled tabs rather than being
hidden, so the roadmap is visible without a separate document. Each tab shares
one skeleton: a connection strip (address, connect/disconnect, status dot in
`success` / `warning` / `error`), a left navigator of addressable items, a
right detail pane. Addresses and raw values are `font-mono`; a value edited but
not committed shows in `warning` until written.

### 5.7 Settings

A single scrolling column, 24 px padded, capped at 800 px, 24 px between
panels. Each panel is a 24 px-padded raised surface headed by a 20 px / 500
title and a 14 px `text-secondary` sentence explaining what the group is for —
the subtitle is mandatory. Groups: **Interface** (capture-source select — dev
generator, simulator link, physical NIC when available — with the selected
source's address field; this is the ONLY place the interface is chosen, per
§4.3; transmit-only switch), **Dependencies** (runtime dependencies of the
capture backends, detected — see below), **Performance** (refresh-rate select with three discrete options,
low-overhead switch), **Automation** (port, bind host, token, allowlist),
**Diagnostics** (collection switches, thresholds, read-only reports),
**Memory** (reclaim controls, anything destructive behind a confirmation
dialog).

A capture that fails to start (source rejected, link refused, dependency
missing) renders the rejection message verbatim as an inline `error` alert
beneath the Interface source select — never swallowed. Groups whose core has
not landed (Performance, Automation, Diagnostics collection, Memory) render
their controls disabled with a caption naming the arriving version — never as
live-looking controls that do nothing (§1 principle 5).

Every control is the small variant; every switch with a consequence carries a
12 px caption indented 32 px beneath it; read-only diagnostic text uses a
multiline `font-mono` field at 12.5 px, 8 rows minimum and 16 maximum, with a
Copy button; status uses small outlined chips with a leading glyph. Any setting
that cannot change while a session runs is disabled with a tooltip stating why
— never silently ignored.

**Dependencies group.** One row per optional runtime dependency a capture
backend needs — Npcap (Windows live capture), libpcap (Linux live capture),
the Vector XL Driver Library and Vector driver package (Vector VN interfaces,
Windows). Each row carries: the dependency name and the sources it enables in
`text-secondary`; a small outlined status chip — `Installed · <version>`,
`Missing`, `Incompatible · <version>` (below the minimum the backend needs),
or `Blocked` (present but unusable, e.g. Npcap installed with driver access
restricted to administrators); the detected path/version in `font-mono`; and,
whenever the chip is not `Installed`, an **Open download page** action that
opens the official vendor page in the system browser. The app never bundles,
downloads, or installs a dependency and never elevates — installing is the
user's act; the row tells them exactly what and where. A **Refresh** button
re-runs the probes; probes are read-only (presence, version, and a
capability query — never a capture side effect). Sources whose dependency is
not `Installed` appear in the Interface select disabled with the reason
("requires Npcap — see Dependencies"). The same probe results are included
verbatim in the Diagnostics report.

### 5.8 Network

A 24 px-padded column of raised panels with 16 px gaps, the last growing and
scrolling — the same panel language as Settings/Recorder. Composition:

- **Connection panel:** everything the core is connected to, live. The active
  capture source (interface kind, address, link state per the session store)
  with a wrapping row of small status chips reporting link state, port and
  counters — from `capture:stats`: `Received n`, `Emitted n`, `Dropped n`
  (`warning` face when non-zero), `Gaps n`, `Malformed n` — followed by a
  per-class line listing only the non-zero classes (`SOME/IP 12,340 · SD 51 ·
  gPTP 800 · ARP 12`); counters reset when a session starts and the final
  values stay visible after it stops, captioned "last session". Errors appear
  as inline alerts beneath the row that caused them,
  not as toasts. Beneath it, one row per **attached external node** (node
  plane, PRD §8.3): id, display name, and its session state
  (CONNECTED / DECLARED / ACTIVE / REJECTED / CLOSED, with the reason on the
  terminal states) as a fixed-width state chip, plus per-node injected/received
  counters and drop count. Automation clients (PRD §8.1) list the same way when
  that surface lands. Empty states name what is absent ("no external nodes
  attached").
- **Topology panel:** ECU nodes with offered services and subscription edges,
  derived passively from observed SD traffic. Node cards carry name over
  address with trailing chips — a filled state chip at fixed 92 px width and
  weight 700 so the card does not reflow as the state string changes.
- **SD monitor panel:** per-service state machine rows with TTL countdowns;
  selecting a state transition selects its frame in Trace.
- **PTP panel:** sync tree plus per-node offset/rate charts through the
  standard chart stack ([SRS_graphing.md](SRS_graphing.md)).

### 5.9 Replay time bar

A shell-level strip present only when a replay source is configured, between
the app bar and the view content: 40 px tall, 12 px horizontal and 8 px
vertical padding, 1 px bottom rule, 12 px gaps. Left to right — a 12 px
`text-secondary` position label of fixed 140 px width formatted
`12.345s / 987.654s` at three decimals; a fast-analysis switch whose caption
turns `info` when engaged, closed by a 1 px right rule with 16 px clearance; a
flexible small slider bounded by the capture's timestamp range; and a small
play/pause button that takes the `warning` tint while paused. Every disabled
state here carries a tooltip naming the precondition.

## 6. Chart visual specification

Behavior — zoom, autoscale, live-follow, cursor semantics — is
[SRS_graphing.md](SRS_graphing.md). This section owns only the pixels.

### 6.1 Series and markers

Lines stroke at 2.0 px CSS width, multiplied by device pixel ratio at draw
time, in the series color at full opacity; the default for an unassigned series
is `info`. Lines are joined, never smoothed — a plotted signal is a sequence of
discrete samples, and curve-fitting between them invents data.

Point markers appear only at low density. With
`samplesPerPx = visibleSamples / plotWidthPx`, no markers draw at 2 or above;
below 2, diameter is `clamp(10 − 4 × samplesPerPx, 4, 8)` CSS px, DPR-scaled,
filled in the series color with no outline.

### 6.2 Plot box and axes

Padding is computed from content. Top is 8 px. Left is
`max(60, 20 + widestYLabelPx + (axisTitle ? titleSize + 14 : 10))`, floored at
44 px for panes under 140 px tall. Bottom is
`max(32, 14 + tickSize + (axisTitle ? titleSize + 8 : 0))`, floored at 24 px
for short panes. Right is `clamp(ceil(widestXLabelPx × 0.2), 12, 24)` — just
enough that the final tick label does not clip.

Bottom and left axis rules are 1 px `text-on-plot`; tick marks extend 5 px
outside the box in `plot-tick`; grid lines span the full box at 1 px in
`plot-grid` on both axes. X labels center under their tick, at least 12 px
below the axis and never within 2 px of the pane edge; Y labels right-align
8 px left of the axis with a baseline offset of 0.35 × font size.

**Tick density.** Allocate at least 60 px per tick:
`maxTicks = max(2, floor(availablePx / 60))`, target `min(maxTicks, 8)`. Steps
come from the 1/2/5/10 series scaled by a power of ten, with a hard cap of 20
emitted ticks as a guard. Labels use fixed decimals derived from the step,
switching to two-digit exponential notation outside 10⁻³ to 10⁶. Below 32 px in
either dimension the axis overlay does not draw at all — a scaled vector
overlay on a near-zero box produces enormous stretched glyphs, and the skip
must be explicit.

### 6.3 Cursor

The vertical crosshair is 1 px `cursor-primary`, dashed 4 px on / 3 px off; the
horizontal is 1 px solid `cursor-secondary` — deliberately dimmer, because the
X position is being read and the Y line is orientation only. Both clip to the
plot box, and the horizontal line's Y clamps to it so the cursor never draws
outside the axes. At each intersection with a visible series, draw a filled
4 px-radius circle in the series color with a 1.5 px `text-on-plot` ring — the
ring is what keeps the dot readable when it lands on its own trace. Hidden
series get no dot.

## 7. Feedback and states

### 7.1 Toasts

Transient messages stack in the bottom-right corner, 24 px from both edges,
8 px apart, newest at the bottom, above all other content, entering with a
single slide. Each is a `surface-raised` card, 16 px padding, 200–400 px wide,
with a **4 px left rule** in the severity color — `accent-primary`
informational, otherwise `success`, `warning`, `error`. Body text is 14 px with
a close button at the right. The container is pointer-transparent and only the
cards accept clicks, so a toast never blocks a control beneath it. Default
dwell 3000 ms; 5000 ms for messages that may need re-reading; zero pins until
dismissed. Identical messages within one second coalesce.

### 7.2 Startup overlay

A full-viewport overlay painted by the document itself before any framework
code runs, so the window is never blank: `surface-canvas` background, centered
column with 16 px gap, a 96 × 96 px product mark and a 13 px uppercase label at
0.08em tracking, 86% opacity. It is removed after mount via a 220 ms opacity
fade with pointer events disabled during the fade. It carries the product's
only decorative animation — a 1.2 s scale-and-opacity pulse on the mark —
permitted precisely because it runs when nothing else does.

### 7.3 Loading, empty, disabled

Indeterminate work shows a centered circular indicator in `accent-primary` on
the region that is loading, never a full-screen blocker; anything expected to
exceed 300 ms adds a caption naming what is loading. Empty states are one line
of 14 px `text-secondary` at 50% opacity stating the condition and the action
that resolves it — centered in a list, inset 12 px from the top-left in a chart
pane so the axes stay visible and the region stays droppable. They never use
illustrations; exactly this one form exists. Disabled controls render at 38%
opacity and keep their tooltip, which states the reason rather than repeating
the control's name.

### 7.4 Error boundary and drag affordances

An uncaught render error replaces the content region with a centered
`surface-raised` card, maximum 600 px, 32 px padding: a heading in `error`, one
plain sentence, a short crash identifier in `text-secondary`, the error text
and component stack in scrollable `font-mono` blocks capped at 200 px each on
`fill-subtle`, and two buttons — copy report, reload. The shell stays alive so
the user can navigate away rather than restart.

Dragged items render at 40% opacity in place with a `grab` cursor becoming
`grabbing`, and a full-opacity preview follows the pointer. Valid drop targets
wash to `fill-subtle`; invalid targets show nothing at all, which is the honest
signal. No target scaling, no bounce on drop.

## 8. Motion policy

RadEAU shall have **almost no animation**. This is a performance stance, not an
aesthetic one. Permitted motion, exhaustively: the nav rail width transition
(225 ms), the startup fade (220 ms) and its mark pulse, and toast entry.
Everything else is instantaneous — selection, toggle, expand, collapse and
pause apply on the same frame as the input, and expanding regions use a
zero-duration transition rather than an animated height. (Measured in prior
art: a slider tooltip's mount/unmount transitions forced synchronous layout at
display rate; removing them recovered real render-thread headroom and nobody
noticed a loss.)

Two rules follow. No element on a hot path — anything that updates with
incoming data — may carry a CSS transition, hover shadow or ripple; that covers
table rows, legend rows, live values and every chart surface. And
`prefers-reduced-motion` is honored by having nothing to reduce: under that
query the three permitted transitions drop to zero and the pulse is suppressed.
That is the whole implementation, testable in one assertion.

Active recording is shown by a static `error` fill on the indicator plus the
run button's color change — never a pulsing animation, which would run
continuously for a whole capture, precisely when the render thread can least
afford it.

## 9. Accessibility and testability

- **Focus.** Every interactive element shows a 2 px `accent-primary` outline at
  2 px offset on keyboard focus. Suppressing the ring on mouse interaction is
  fine; suppressing it on the keyboard path never is. Tab order follows visual
  order: app bar, rail, then view content in reading order.
- **Icon-only controls.** Every one carries an `aria-label` matching its
  tooltip text; toggles additionally expose `aria-pressed`, navigation items
  `aria-current`.
- **Color is never the sole carrier of state.** Every state indicated by color
  has a second, non-chromatic carrier — a glyph change, a text token, a border
  or a position. Roughly one in twelve users cannot rely on a sixteen-hue
  palette, which is exactly why the legend, not the plot, is the authoritative
  mapping.
- **Contrast.** `text-primary` exceeds 12:1 on both surfaces, `text-secondary`
  exceeds 4.5:1, and every series color exceeds the 3:1 graphical-object
  threshold on `surface-canvas`; any new series color is validated against it
  before being added.
- **Test hooks are a shipping requirement.** Every interactive control carries
  a stable `data-testid` — not most, every one. Values are kebab-case and
  scoped by view or component (`nav-trace`, `trace-pause-btn`,
  `plotter-zoom-mode-x`); dynamic collections take a suffixed identifier
  (`legend-row-<signalId>`), and the whole set is public API: renaming one is a
  breaking change requiring the harness update in the same commit. The E2E
  harness selects exclusively on these attributes, never on class names, text
  content or DOM position. Code review rejects any new interactive element
  without one.

## 10. Requirements

| ID | Requirement | Priority | Status | Acceptance criteria |
|---|---|---|---|---|
| VU-001 | Ship a single dark theme with no light variant or switch | Must | Verified | No theme control exists; the palette resolves to one set of values |
| VU-002 | Define all colors once in a token module; no component contains a color literal | Must | Verified | A CI lint rule fails the build on any hex or rgb literal outside the token module |
| VU-003 | Apply no depth-based background tinting to panel surfaces | Must | Verified | Sampled panel luminance is identical at nesting depths 1 and 3 |
| VU-004 | Contain exactly the 16 specified series colors in the specified order | Must | Verified | Unit test asserts contents and order |
| VU-005 | Assign a new series the first unused palette color, falling back to index modulo 16 | Must | Planned | Removing and re-adding a signal reclaims the freed color; 17 signals do not crash |
| VU-006 | Bundle both font stacks with the application | Must | Implemented | Rendering is identical on a host with neither family installed |
| VU-007 | Use tabular numerals in all numeric columns and live readouts | Must | Implemented | Element width is unchanged across 1000 updates spanning all digit shapes |
| VU-008 | Run undecorated with an application-drawn title bar and drag region | Must | Implemented | Dragging the app bar background moves the window; dragging any control does not |
| VU-009 | Default the window to 1440 × 900 and enforce a 1024 × 700 minimum | Must | Implemented | Resizing below the minimum is refused; no app bar control clips at the minimum |
| VU-010 | Size the nav rail 65 px collapsed and 240 px expanded, labels hidden but present when collapsed | Must | Implemented | Measured widths match; accessible names are available in both states |
| VU-011 | Compute legend width from measured labels, clamped to [180, min(420, container − 320)] px | Must | Planned | Width matches the formula for 0, 1 and 16 signals at three container widths, and persists across restart |
| VU-012 | Declare a constant row height on every virtualized list: 48 px legend, 32 px trace | Must | Implemented | No measurement callback fires during a 10,000-row scroll |
| VU-013 | Zero-pad frame identifiers to their format's digit count and right-align all numeric columns | Must | Verified | Column width is stable across identifier lengths; decimal points align vertically |
| VU-014 | Carry frame direction and error status by a text token as well as a color | Must | Verified | A grayscale capture of a mixed trace distinguishes received, transmitted and malformed frames |
| VU-015 | Indicate the paused state inside the affected region, not only on its control | Must | Planned | A user viewing only the table area can determine the paused state without panning |
| VU-016 | Allocate at least 60 px per axis tick and emit at most 8 ticks per axis | Must | Planned | A 200 px axis carries at most 3 ticks; no labels overlap at any pane size |
| VU-017 | Draw point markers only below 2 samples per pixel, sized 4–8 px | Must | Planned | No markers above the threshold; size matches the formula at 0.5 and 1.5 samples/px |
| VU-018 | Suppress the axis overlay when either pane dimension is below 32 CSS px | Must | Planned | Revealing a hidden pane produces no frame with oversized labels |
| VU-019 | Put no CSS transition, hover shadow or ripple on any element that updates with incoming data | Must | Verified | Computed-style audit over table rows, legend rows and chart surfaces reports 0 s durations |
| VU-020 | Limit all animation to the rail transition, the startup fade and pulse, and toast entry | Must | Verified | An automated computed-style sweep finds no other non-zero transition or animation |
| VU-021 | Drop every permitted transition to zero duration under prefers-reduced-motion | Must | Implemented | A single assertion over the same sweep with the media query forced |
| VU-022 | Give every interactive element a stable kebab-case data-testid and, if icon-only, a matching aria-label | Must | Verified | A CI static scan reports zero interactive elements lacking either attribute |
| VU-023 | Give every color-indicated state a second non-chromatic indicator | Must | Implemented | Grayscale review of each view identifies all states unambiguously |
| VU-024 | Show keyboard focus as a 2 px accent outline at 2 px offset on every interactive element | Must | Planned | Tabbing through each view shows a ring at every stop |
| VU-025 | Paint a startup overlay before framework mount and fade it over 220 ms after mount | Should | Implemented | No frame between window creation and mount shows a blank window |
| VU-026 | Meet 4.5:1 contrast for text and 3:1 for series colors against their surfaces | Must | Verified | Automated contrast check over the token set and all 16 series colors passes |
| VU-027 | A hidden keep-alive view performs zero React commits; a visible view and the app bar re-render only when a value they display changes — live counters re-render as isolated leaves at the stats rate | Must | Verified | Render-count unit test (stats republish does not re-render a non-stats component); perf: hidden views 0 commits/s, app bar ≤ 2/s |
