import {
  Alert,
  Badge,
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  FormLabel,
  IconButton,
  MenuItem,
  Popover,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SxProps } from "@mui/material";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import DownloadIcon from "@mui/icons-material/Download";
import FilterListIcon from "@mui/icons-material/FilterList";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import TuneIcon from "@mui/icons-material/Tune";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { TableVirtuoso } from "react-virtuoso";
import type { TableComponents } from "react-virtuoso";
import { EmptyState } from "../components/EmptyState";
import { TraceDetailPanel } from "../components/TraceDetailPanel";
import { TraceFilterPopover } from "../components/TraceFilterPopover";
import { useViewLifecycle } from "../shell/viewLifecycle";
import {
  captureButtonLabel,
  linkChipColorVar,
  linkChipLabel,
  droppedBreakdownTooltip,
  lossTotal,
  showDegradedLinkChip,
} from "../runtime/captureSource";
import { ackFrames, isDesktop, onFrameBatch } from "../runtime/desktop";
import {
  captureTraceExpansion,
  rowMatchesExpansion,
  type TraceExpansion,
} from "../runtime/frameDetail";
import {
  catalogBadgeTone,
  catalogCountsLabel,
  catalogDiagCountLabel,
  catalogLastErrorMessage,
  catalogSeverityGlyph,
  catalogSourceLabel,
  CATALOG_NO_DIAGNOSTICS,
} from "../runtime/catalogDisplay";
import { catalogStore } from "../runtime/catalogStore";
import { recordingChipLabel } from "../runtime/recorderDisplay";
import { recordingStore } from "../runtime/recordingStore";
import { runExportRing } from "../runtime/ringExport";
import { sessionStore } from "../runtime/sessionStore";
import {
  DEFAULT_HISTORY_WINDOW,
  DEFAULT_TRACE_MODE,
  fixedDisplayKey,
  HISTORY_WINDOW_OPTIONS,
  projectDisplayRows,
  type HistoryWindow,
  type TraceDisplayMode,
} from "../runtime/traceDisplay";
import {
  distinctValues,
  EMPTY_FILTER,
  isColumnFilterActive,
  isFilterActive,
  type TraceFilter,
  type TraceFilterColumn,
  type TraceFilterDir,
  type TraceFilterOption,
} from "../runtime/traceFilter";
import {
  DEFAULT_TRACE_TIME_MODE,
  formatTraceTime,
  wallTimeDisabledReason,
  type TraceTimeMode,
} from "../runtime/traceTime";
import { traceStore } from "../runtime/traceStore";
import type { TraceFrame } from "../runtime/frameModel";

// ---------------------------------------------------------------------------
// Columns (SRS_visual_ui.md §5.2). Pin is fixed-mode only.
// ---------------------------------------------------------------------------

interface ColumnDef {
  id: string;
  label: string;
  width: number;
  align: "left" | "right" | "center";
  filter?: { testId: string; label: string; column: TraceFilterColumn };
}

const BASE_COLUMNS: ColumnDef[] = [
  { id: "expand", label: "", width: 40, align: "center" },
  { id: "time", label: "Time", width: 120, align: "right" },
  {
    id: "dir",
    label: "Dir",
    width: 70,
    align: "left",
    filter: { testId: "trace-filter-btn-dir", label: "Filter direction", column: "dir" },
  },
  { id: "source", label: "Source", width: 90, align: "left" },
  {
    id: "protocol",
    label: "Protocol",
    width: 90,
    align: "left",
    filter: {
      testId: "trace-filter-btn-protocol",
      label: "Filter protocol",
      column: "protocol",
    },
  },
  {
    id: "svcmethod",
    label: "Service:Method",
    width: 130,
    align: "right",
    filter: {
      testId: "trace-filter-btn-service",
      label: "Filter services",
      column: "service",
    },
  },
  {
    id: "name",
    label: "Name",
    width: 200,
    align: "left",
    filter: { testId: "trace-filter-btn-name", label: "Filter names", column: "name" },
  },
  { id: "type", label: "Type", width: 70, align: "left" },
  { id: "session", label: "Session", width: 70, align: "right" },
  { id: "length", label: "Length", width: 70, align: "right" },
  { id: "payload", label: "Payload", width: 300, align: "left" },
  { id: "dglobal", label: "Δ global", width: 100, align: "right" },
  { id: "dkey", label: "Δ per key", width: 100, align: "right" },
  { id: "channel", label: "Ch", width: 50, align: "right" },
];

const PIN_COLUMN: ColumnDef = { id: "pin", label: "Pin", width: 44, align: "center" };

function columnsForMode(mode: TraceDisplayMode): ColumnDef[] {
  return mode === "fixed" ? [...BASE_COLUMNS, PIN_COLUMN] : BASE_COLUMNS;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const MONO: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};

const MONO_RIGHT: CSSProperties = { ...MONO, textAlign: "right" };

const RAIL_SLOT_SX: SxProps = {
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const TABLE_WRAP_SX: SxProps = {
  height: "100%",
  "& th": {
    backgroundColor: "var(--surface-raised-2)",
    fontSize: 14,
    fontWeight: 500,
    padding: "8px",
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  "& td": {
    height: 32,
    boxSizing: "border-box",
    padding: "0 8px",
    fontSize: 14,
    borderBottom: "1px solid var(--border)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Hover wash only — no zebra, no transition (VU-019).
  "& tbody tr:hover td": { backgroundColor: "var(--fill-subtle)" },
  // Expansion detail sits in a second <tr>; unlock height / wrapping.
  "& td.trace-detail-cell": {
    height: "auto",
    whiteSpace: "normal",
    overflow: "visible",
    textOverflow: "clip",
    padding: 0,
    verticalAlign: "top",
    borderBottom: "1px solid var(--border)",
  },
  "& tbody tr:hover td.trace-detail-cell": { backgroundColor: "transparent" },
  // Row action buttons are plain elements: thousands re-render per second
  // under a live trace, and a MUI Tooltip + IconButton per cell dominated the
  // UI thread. Native `title` keeps the hover tooltip.
  "& button.trace-row-btn": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    padding: 0,
    margin: 0,
    border: 0,
    borderRadius: "50%",
    background: "transparent",
    color: "var(--text-secondary)",
    cursor: "default",
    "& svg": { fill: "currentColor" },
  },
  "& button.trace-row-btn:hover": { backgroundColor: "var(--fill-subtle)" },
  "& button.trace-row-btn:focus-visible": {
    outline: "2px solid var(--accent-primary)",
    outlineOffset: -2,
  },
  "& button.trace-row-btn[aria-pressed='true']": { color: "var(--accent-primary)" },
};

// Material "ChevronRight" / "PushPin" glyphs inlined for the hot row cells.
const CHEVRON_RIGHT_PATH = "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z";
const PUSH_PIN_PATH =
  "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z";

// ---------------------------------------------------------------------------
// Table pieces
// ---------------------------------------------------------------------------

interface TraceTableContext {
  columns: ColumnDef[];
  mode: TraceDisplayMode;
  pinned: ReadonlySet<string>;
  onTogglePin: (key: string) => void;
  expansion: TraceExpansion | null;
  onToggleExpand: (frame: TraceFrame) => void;
  timeMode: TraceTimeMode;
  sessionEpochMs: number | null;
}

function makeTableComponents(columns: ColumnDef[]): TableComponents<TraceFrame, TraceTableContext> {
  const minWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const colCount = columns.length;
  return {
    Table: ({ style, children, context: _context, ...rest }) => (
      <table
        {...rest}
        style={{
          ...style,
          tableLayout: "fixed",
          borderCollapse: "separate",
          borderSpacing: 0,
          minWidth,
        }}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={{ width: c.width }} />
          ))}
        </colgroup>
        {children}
      </table>
    ),
    // Second <tr> for the dissection panel; omit fixedItemHeight so Virtuoso measures.
    TableRow: ({ children, style, item, context, ...rest }) => {
      const expanded =
        context.expansion !== null && rowMatchesExpansion(context.mode, item, context.expansion);
      return (
        <>
          <tr {...rest} style={style}>
            {children}
          </tr>
          {expanded && context.expansion ? (
            <tr data-testid={`trace-detail-row-${context.expansion.idx}`}>
              <td colSpan={colCount} className="trace-detail-cell">
                <TraceDetailPanel
                  idx={context.expansion.idx}
                  showCapturedIdx={context.expansion.showCapturedIdx}
                />
              </td>
            </tr>
          ) : null}
        </>
      );
    },
  };
}

function renderHeader(
  columns: ColumnDef[],
  filter: TraceFilter,
  onOpenFilter: (column: TraceFilterColumn, el: HTMLElement) => void,
): ReactNode {
  return (
    <tr>
      {columns.map((c) => (
        <th key={c.id} style={{ textAlign: c.align }}>
          {c.filter ? (
            <Box
              component="span"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: "2px",
                justifyContent: c.align === "right" ? "flex-end" : "flex-start",
              }}
            >
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {c.label}
              </Box>
              <Tooltip title={c.filter.label}>
                <IconButton
                  size="small"
                  aria-label={c.filter.label}
                  aria-pressed={isColumnFilterActive(filter, c.filter.column)}
                  data-testid={c.filter.testId}
                  onClick={(e) => onOpenFilter(c.filter!.column, e.currentTarget)}
                  sx={{
                    p: "2px",
                    color: isColumnFilterActive(filter, c.filter.column)
                      ? "var(--accent-primary)"
                      : "text.secondary",
                  }}
                >
                  <FilterListIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Box>
          ) : (
            c.label
          )}
        </th>
      ))}
    </tr>
  );
}

/** Committed popover draft keys for one column (string form). */
function committedKeys(
  filter: TraceFilter,
  column: TraceFilterColumn,
): ReadonlySet<string> | null {
  switch (column) {
    case "service":
      return filter.services;
    case "name":
      return filter.names;
    case "protocol":
      return filter.protocols === null
        ? null
        : new Set(Array.from(filter.protocols, String));
    case "dir":
      return filter.dirs;
  }
}

function rowContent(
  _index: number,
  f: TraceFrame,
  context: TraceTableContext | undefined,
): ReactNode {
  const key = fixedDisplayKey(f);
  const pinned = context?.pinned.has(key) ?? false;
  const expanded =
    context?.expansion != null &&
    rowMatchesExpansion(context.mode, f, context.expansion);
  const expandLabel = expanded ? "Collapse row" : "Expand row";
  return (
    <>
      <td style={{ textAlign: "center", padding: 0 }}>
        <button
          type="button"
          className="trace-row-btn"
          title={expandLabel}
          aria-label={expandLabel}
          aria-expanded={expanded}
          data-testid={`trace-expand-btn-${f.id}`}
          onClick={() => context?.onToggleExpand(f)}
        >
          <svg
            viewBox="0 0 24 24"
            width={16}
            height={16}
            aria-hidden="true"
            style={{ transform: expanded ? "rotate(90deg)" : "none" }}
          >
            <path d={CHEVRON_RIGHT_PATH} />
          </svg>
        </button>
      </td>
      <td style={MONO_RIGHT} data-testid={`trace-time-cell-${f.id}`}>
        {context
          ? formatTraceTime(f.tS, context.timeMode, context.sessionEpochMs)
          : f.time}
      </td>
      <td
        style={{
          color:
            f.dir === "rx"
              ? "var(--info)"
              : f.dir === "tx"
                ? "var(--accent-secondary)"
                : "var(--text-secondary)",
        }}
      >
        {f.dir === "rx" ? "Rx" : f.dir === "tx" ? "Tx" : "—"}
      </td>
      <td title={f.sourceTitle}>{f.source}</td>
      <td style={f.protocol === "Malformed" ? { color: "var(--error)" } : undefined}>
        {f.protocol}
      </td>
      <td style={MONO_RIGHT}>{f.serviceMethod}</td>
      <td>{f.name}</td>
      <td>{f.type}</td>
      <td style={MONO_RIGHT}>{f.session}</td>
      <td style={MONO_RIGHT}>{f.length}</td>
      <td style={MONO}>{f.payload}</td>
      <td style={MONO_RIGHT}>{f.deltaGlobal}</td>
      <td style={MONO_RIGHT}>{f.deltaKey}</td>
      <td style={MONO_RIGHT}>{f.channel}</td>
      {context?.mode === "fixed" ? (
        <td style={{ textAlign: "center", padding: 0 }}>
          <button
            type="button"
            className="trace-row-btn"
            title={pinned ? "Unpin row" : "Pin row"}
            aria-label={pinned ? "Unpin row" : "Pin row"}
            aria-pressed={pinned}
            data-testid={`trace-pin-btn-${key}`}
            onClick={() => context.onTogglePin(key)}
          >
            <svg
              viewBox="0 0 24 24"
              width={16}
              height={16}
              aria-hidden="true"
              style={{ transform: pinned ? "none" : "rotate(45deg)" }}
            >
              <path d={PUSH_PIN_PATH} />
            </svg>
          </button>
        </td>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function TraceView() {
  useViewLifecycle("trace", {});
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const recording = useSyncExternalStore(recordingStore.subscribe, recordingStore.getSnapshot);
  const catalog = useSyncExternalStore(catalogStore.subscribe, catalogStore.getSnapshot);
  const capturing = session.running;
  const sourceKind = session.sourceKind;
  const linkStatus = session.linkStatus;
  const catalogLoaded = catalog.loaded;

  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<TraceDisplayMode>(DEFAULT_TRACE_MODE);
  const [timeMode, setTimeMode] = useState<TraceTimeMode>(DEFAULT_TRACE_TIME_MODE);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(DEFAULT_HISTORY_WINDOW);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<TraceFilter>(EMPTY_FILTER);
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const [catalogAnchor, setCatalogAnchor] = useState<HTMLElement | null>(null);
  const [expansion, setExpansion] = useState<TraceExpansion | null>(null);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [filterColumn, setFilterColumn] = useState<TraceFilterColumn | null>(null);
  const [filterOptions, setFilterOptions] = useState<readonly TraceFilterOption[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const snap = useSyncExternalStore(traceStore.subscribe, traceStore.getSnapshot);
  const displayRows = useMemo(
    () => projectDisplayRows(snap.rows, mode, pinned, historyWindow, filter),
    [snap.rows, mode, pinned, historyWindow, filter],
  );
  const filterActive = isFilterActive(filter);
  const columns = useMemo(() => columnsForMode(mode), [mode]);
  const tableComponents = useMemo(() => makeTableComponents(columns), [columns]);
  const sessionEpochMs = session.sessionInfo?.sessionEpochMs ?? null;
  const wallDisabledReason = wallTimeDisabledReason(sessionEpochMs);

  const tableContext = useMemo<TraceTableContext>(
    () => ({
      columns,
      mode,
      pinned,
      expansion,
      timeMode,
      sessionEpochMs,
      onTogglePin: (key: string) => {
        setPinned((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      },
      onToggleExpand: (frame: TraceFrame) => {
        setExpansion((prev) => {
          const next = captureTraceExpansion(mode, frame);
          if (prev && prev.slotKey === next.slotKey) return null;
          return next;
        });
      },
    }),
    [columns, mode, pinned, expansion, timeMode, sessionEpochMs],
  );

  // Auto-dismiss the export result chip.
  useEffect(() => {
    if (!exportResult) return;
    const t = setTimeout(() => setExportResult(null), 6_000);
    return () => clearTimeout(t);
  }, [exportResult]);

  // Live pipeline: subscribe to batches while the shared session is running;
  // restore exactly one backpressure credit per animation frame on desktop.
  useEffect(() => {
    if (!capturing) return;
    const unsubscribe = onFrameBatch((batch) => {
      if (sessionStore.getSnapshot().running) traceStore.ingest(batch);
    });
    let raf = 0;
    if (isDesktop()) {
      const loop = (): void => {
        ackFrames(1);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [capturing]);

  const togglePause = (): void => {
    setPaused((v) => {
      traceStore.setPaused(!v);
      return !v;
    });
  };

  const openSettings = (e: MouseEvent<HTMLElement>): void => {
    setSettingsAnchor(e.currentTarget);
  };

  const openFilter = (column: TraceFilterColumn, el: HTMLElement): void => {
    // Option list from the ring snapshot at open — not live-updating under the popover.
    setFilterOptions(distinctValues(snap.rows, column));
    setFilterColumn(column);
    setFilterAnchor(el);
  };

  const closeFilter = (): void => {
    setFilterAnchor(null);
    setFilterColumn(null);
  };

  const applyColumnFilter = (next: ReadonlySet<string> | null): void => {
    if (filterColumn === null) return;
    const column = filterColumn;
    setFilter((prev) => {
      switch (column) {
        case "service":
          return { ...prev, services: next };
        case "name":
          return { ...prev, names: next };
        case "protocol": {
          const protocols =
            next === null ? null : new Set(Array.from(next, (k) => Number(k)));
          return { ...prev, protocols };
        }
        case "dir": {
          const dirs =
            next === null ? null : (new Set(next) as Set<TraceFilterDir>);
          return { ...prev, dirs };
        }
      }
    });
    // Applying a filter clears expansion the way a mode change does (§5.2).
    setExpansion(null);
    closeFilter();
  };

  const captureLabel = captureButtonLabel(capturing, sourceKind);
  const pauseLabel = paused ? "Resume" : "Pause";
  const catalogActionLabel = catalogStore.railActionLabel();
  const catalogTooltip = catalogStore.railTooltip();
  const badgeTone = catalogBadgeTone({
    loaded: catalog.loaded,
    errors: catalog.errors,
    warnings: catalog.warnings,
    lastError: catalog.lastError,
  });
  const badgeColorVar =
    badgeTone === "error"
      ? "var(--error)"
      : badgeTone === "warning"
        ? "var(--warning)"
        : "var(--success)";
  const clearLabel =
    snap.rows.length > 0 ? "Clear trace" : "Trace is already empty";
  const exportLabel =
    snap.rows.length === 0
      ? "no frames buffered"
      : "Export buffered frames as pcap";
  const showLinkChip = showDegradedLinkChip(capturing, sourceKind, linkStatus?.state);
  const chipColor = linkStatus ? linkChipColorVar(linkStatus.state) : "var(--text-secondary)";
  const stats = session.stats;
  const dropped = stats && capturing ? lossTotal(stats) : 0;
  const showDroppedChip = dropped > 0;
  const droppedTooltip = stats ? droppedBreakdownTooltip(stats) : "";
  const showRecordingChip = recording.active;
  const showChipStack =
    paused ||
    showLinkChip ||
    showDroppedChip ||
    showRecordingChip ||
    filterActive ||
    exportResult !== null;

  const onExport = (): void => {
    if (exportBusy || snap.rows.length === 0) return;
    setExportBusy(true);
    void runExportRing().then((outcome) => {
      setExportBusy(false);
      if (outcome.message === "export cancelled") return;
      setExportResult({ ok: outcome.ok, message: outcome.message });
    });
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" }}>
      {/* Vertical control rail (§5.2): 50 px, raised, 16 px top pad, 40 px pitch */}
      <Box
        sx={{
          width: 50,
          flexShrink: 0,
          backgroundColor: "var(--surface-raised)",
          borderRight: "1px solid var(--border)",
          pt: "16px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title={captureLabel} placement="right">
            <IconButton
              size="small"
              aria-label={captureLabel}
              aria-pressed={capturing}
              onClick={() => {
                void sessionStore.toggle();
              }}
              data-testid="trace-capture-btn"
              sx={{ color: capturing ? "var(--success)" : "text.secondary" }}
            >
              {capturing ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title="Display settings" placement="right">
            <IconButton
              size="small"
              aria-label="Display settings"
              aria-expanded={settingsAnchor !== null}
              onClick={openSettings}
              data-testid="trace-display-settings-btn"
              sx={{
                color: settingsAnchor ? "var(--accent-primary)" : "text.secondary",
              }}
            >
              <TuneIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Popover
            open={settingsAnchor !== null}
            anchorEl={settingsAnchor}
            onClose={() => setSettingsAnchor(null)}
            anchorOrigin={{ vertical: "center", horizontal: "right" }}
            transformOrigin={{ vertical: "center", horizontal: "left" }}
          >
            <Box sx={{ width: 260, p: "12px" }} data-testid="trace-display-settings-popover">
              <FormControl component="fieldset" sx={{ mb: 1.5, width: "100%" }}>
                <FormLabel component="legend" sx={{ fontSize: 12, mb: 0.5 }}>
                  Mode
                </FormLabel>
                <RadioGroup
                  value={mode}
                  onChange={(_, value) => {
                    setMode(value as TraceDisplayMode);
                    setExpansion(null);
                  }}
                  data-testid="trace-mode-group"
                >
                  <FormControlLabel
                    value="fixed"
                    data-testid="trace-mode-fixed"
                    control={<Radio size="small" inputProps={{ "aria-label": "Fixed mode" }} />}
                    label={<Typography sx={{ fontSize: 13 }}>Fixed</Typography>}
                  />
                  <FormControlLabel
                    value="sequential"
                    data-testid="trace-mode-sequential"
                    control={<Radio size="small" inputProps={{ "aria-label": "Sequential mode" }} />}
                    label={<Typography sx={{ fontSize: 13 }}>Sequential</Typography>}
                  />
                </RadioGroup>
              </FormControl>
              <FormControl component="fieldset" sx={{ mb: 1.5, width: "100%" }}>
                <FormLabel component="legend" sx={{ fontSize: 12, mb: 0.5 }}>
                  Time
                </FormLabel>
                <RadioGroup
                  value={timeMode}
                  onChange={(_, value) => {
                    setTimeMode(value as TraceTimeMode);
                  }}
                  data-testid="trace-time-mode-group"
                >
                  <FormControlLabel
                    value="session"
                    data-testid="trace-time-mode-session"
                    control={
                      <Radio size="small" inputProps={{ "aria-label": "Session time" }} />
                    }
                    label={<Typography sx={{ fontSize: 13 }}>Session (s)</Typography>}
                  />
                  <Tooltip
                    title={wallDisabledReason ?? ""}
                    disableHoverListener={wallDisabledReason === null}
                  >
                    <Box component="span">
                      <FormControlLabel
                        value="wall"
                        data-testid="trace-time-mode-wall"
                        disabled={wallDisabledReason !== null}
                        control={
                          <Radio
                            size="small"
                            inputProps={{ "aria-label": "Wall-clock time" }}
                          />
                        }
                        label={<Typography sx={{ fontSize: 13 }}>Wall clock</Typography>}
                      />
                    </Box>
                  </Tooltip>
                </RadioGroup>
              </FormControl>
              <TextField
                select
                fullWidth
                size="small"
                label="History window"
                value={historyWindow}
                disabled={mode === "fixed"}
                onChange={(e) => setHistoryWindow(Number(e.target.value) as HistoryWindow)}
                helperText={
                  mode === "fixed"
                    ? "Applies in Sequential mode"
                    : "Max rows retained at the tail"
                }
                data-testid="trace-history-window"
                sx={{ "& .MuiInputBase-root": { fontSize: 13 } }}
              >
                {HISTORY_WINDOW_OPTIONS.map((n) => (
                  <MenuItem
                    key={n}
                    value={n}
                    data-testid={`trace-history-window-${n}`}
                  >
                    {n.toLocaleString()} rows
                  </MenuItem>
                ))}
              </TextField>
            </Box>
          </Popover>
        </Box>
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title={catalogTooltip} placement="right">
            <IconButton
              size="small"
              aria-label={catalogActionLabel}
              aria-pressed={catalogLoaded}
              aria-haspopup="dialog"
              aria-expanded={Boolean(catalogAnchor)}
              onClick={(e) => setCatalogAnchor(e.currentTarget)}
              data-testid="trace-catalog-btn"
              sx={{ color: "text.secondary" }}
            >
              <Badge
                variant="dot"
                overlap="circular"
                invisible={badgeTone === "hidden"}
                data-testid="trace-catalog-badge"
                sx={{
                  "& .MuiBadge-badge": {
                    backgroundColor: badgeColorVar,
                    minWidth: "6px",
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                  },
                }}
              >
                <MenuBookIcon fontSize="small" />
              </Badge>
            </IconButton>
          </Tooltip>
          <Popover
            open={Boolean(catalogAnchor)}
            anchorEl={catalogAnchor}
            onClose={() => setCatalogAnchor(null)}
            anchorOrigin={{ vertical: "center", horizontal: "right" }}
            transformOrigin={{ vertical: "center", horizontal: "left" }}
          >
            <Box sx={{ width: 300, p: "12px" }} data-testid="trace-catalog-popover">
              <Stack spacing={1.5}>
                <Typography
                  data-testid="trace-catalog-source"
                  sx={{ fontSize: 13, color: "text.primary" }}
                >
                  {catalogSourceLabel(catalog.source, catalog.sourceKind)}
                </Typography>
                <Typography
                  data-testid="trace-catalog-counts"
                  sx={{ fontSize: 12, color: "text.secondary" }}
                >
                  {catalogCountsLabel(catalog.serviceCount, catalog.signalCount)}
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      void catalogStore.importArxml();
                    }}
                    data-testid="trace-catalog-import"
                  >
                    Import ARXML…
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={catalog.sourceKind === "embedded" || !catalog.source}
                    onClick={() => {
                      void catalogStore.reload();
                    }}
                    data-testid="trace-catalog-reload"
                  >
                    Reload
                  </Button>
                </Stack>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={catalogLoaded}
                      onChange={() => {
                        void catalogStore.toggleDecode();
                      }}
                      inputProps={{ "aria-label": "Decode" }}
                      data-testid="trace-catalog-decode"
                    />
                  }
                  label={<Typography sx={{ fontSize: 14 }}>Decode</Typography>}
                />
                <Box>
                  <Typography
                    sx={{ fontSize: 12, color: "text.secondary", mb: 0.5 }}
                  >
                    {catalogDiagCountLabel(catalog.errors, catalog.warnings)}
                  </Typography>
                  <Box
                    data-testid="trace-catalog-diagnostics"
                    sx={{
                      maxHeight: 250,
                      overflowY: "auto",
                      border: "1px solid var(--border)",
                      borderRadius: 1,
                      bgcolor: "var(--fill-subtle)",
                      p: "8px",
                    }}
                  >
                    {catalog.diagnostics.length === 0 ? (
                      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                        {CATALOG_NO_DIAGNOSTICS}
                      </Typography>
                    ) : (
                      catalog.diagnostics.map((d, i) => (
                        <Stack
                          key={`${d.path}-${i}`}
                          direction="row"
                          spacing={1}
                          alignItems="flex-start"
                          sx={{
                            mb: i < catalog.diagnostics.length - 1 ? 0.75 : 0,
                          }}
                        >
                          <Box
                            component="span"
                            sx={{
                              fontSize: 12,
                              color:
                                d.severity === "error"
                                  ? "var(--error)"
                                  : d.severity === "warn"
                                    ? "var(--warning)"
                                    : "var(--info)",
                              flexShrink: 0,
                              lineHeight: 1.4,
                            }}
                            aria-label={d.severity}
                          >
                            {catalogSeverityGlyph(d.severity)}
                          </Box>
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography
                              sx={{
                                fontFamily: "var(--font-mono)",
                                fontSize: 11,
                                color: "text.secondary",
                                wordBreak: "break-all",
                              }}
                            >
                              {d.path}
                            </Typography>
                            <Typography sx={{ fontSize: 12, color: "text.primary" }}>
                              {d.message}
                            </Typography>
                          </Box>
                        </Stack>
                      ))
                    )}
                  </Box>
                </Box>
                {catalog.lastError ? (
                  <Alert severity="error" data-testid="trace-catalog-error">
                    {catalogLastErrorMessage(catalog.lastError)}
                  </Alert>
                ) : null}
              </Stack>
            </Box>
          </Popover>
        </Box>
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title={pauseLabel} placement="right">
            <IconButton
              size="small"
              aria-label={pauseLabel}
              aria-pressed={paused}
              onClick={togglePause}
              data-testid="trace-pause-btn"
              sx={{ color: paused ? "var(--warning)" : "text.secondary" }}
            >
              {paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title={clearLabel} placement="right">
            <span>
              <IconButton
                size="small"
                aria-label={clearLabel}
                disabled={snap.rows.length === 0}
                onClick={() => {
                  // Clear keeps the session-scoped filter (like pins surviving
                  // filter round-trips — filter itself is not cleared here).
                  traceStore.clear();
                  setPinned(new Set());
                  setExpansion(null);
                }}
                data-testid="trace-clear-btn"
                sx={{ color: "text.secondary" }}
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title={exportLabel} placement="right">
            <span>
              <IconButton
                size="small"
                aria-label="Export buffered frames as pcap"
                disabled={snap.rows.length === 0 || exportBusy}
                onClick={onExport}
                data-testid="trace-export-btn"
                sx={{ color: "text.secondary" }}
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* Table region — interface *choice* lives in Settings (§4.3 / §5.7). */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          backgroundColor: "var(--surface-canvas)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
          {paused ? (
            <Box
              data-testid="trace-paused-rule"
              sx={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "2px",
                backgroundColor: "var(--warning)",
                zIndex: 3,
                pointerEvents: "none",
              }}
            />
          ) : null}
          {/* Top-right status chips: Filtered + Paused + Dropped + degraded link (§4.3 / §5.2). */}
          {showChipStack ? (
            <Stack
              spacing={1}
              alignItems="flex-end"
              sx={{ position: "absolute", top: 10, right: 20, zIndex: 3 }}
            >
              {filterActive ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Filtered · ${displayRows.length.toLocaleString("en-US")} / ${snap.rows.length.toLocaleString("en-US")}`}
                  data-testid="trace-filtered-chip"
                  sx={{
                    height: 22,
                    fontSize: 12,
                    color: "var(--info)",
                    borderColor: "var(--info)",
                    backgroundColor: "var(--surface-raised-2)",
                  }}
                />
              ) : null}
              {paused ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Paused · ${snap.pausedBuffered} buffered`}
                  data-testid="trace-paused-chip"
                  sx={{
                    height: 22,
                    fontSize: 12,
                    color: "var(--warning)",
                    borderColor: "var(--warning)",
                    backgroundColor: "var(--surface-raised-2)",
                  }}
                />
              ) : null}
              {showDroppedChip ? (
                <Tooltip title={droppedTooltip}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`Dropped · ${dropped.toLocaleString("en-US")}`}
                    data-testid="trace-dropped-chip"
                    sx={{
                      height: 22,
                      fontSize: 12,
                      color: "var(--warning)",
                      borderColor: "var(--warning)",
                      backgroundColor: "var(--surface-raised-2)",
                    }}
                  />
                </Tooltip>
              ) : null}
              {showRecordingChip ? (
                <Tooltip title={recording.path ?? "Recording"}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={recordingChipLabel(recording.frames)}
                    data-testid="trace-recording-chip"
                    sx={{
                      height: 22,
                      fontSize: 12,
                      color: "var(--error)",
                      borderColor: "var(--error)",
                      backgroundColor: "var(--surface-raised-2)",
                    }}
                  />
                </Tooltip>
              ) : null}
              {showLinkChip && linkStatus ? (
                <Tooltip title={linkStatus.detail ?? linkChipLabel(linkStatus.state)}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={linkChipLabel(linkStatus.state)}
                    data-testid="trace-link-chip"
                    sx={{
                      height: 22,
                      fontSize: 12,
                      color: chipColor,
                      borderColor: chipColor,
                      backgroundColor: "var(--surface-raised-2)",
                    }}
                  />
                </Tooltip>
              ) : null}
              {exportResult ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={exportResult.message}
                  data-testid="trace-export-result"
                  sx={{
                    height: 22,
                    fontSize: 12,
                    color: exportResult.ok ? "var(--success)" : "var(--error)",
                    borderColor: exportResult.ok ? "var(--success)" : "var(--error)",
                    backgroundColor: "var(--surface-raised-2)",
                    maxWidth: 360,
                    "& .MuiChip-label": {
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    },
                  }}
                />
              ) : null}
            </Stack>
          ) : null}
          {snap.rows.length === 0 ? (
            <EmptyState
              text="No frames captured — start the capture or resume the trace"
              testId="trace-empty"
            />
          ) : (
            <Box sx={{ height: "100%", position: "relative" }}>
              {/* Keep the header (and filter glyphs) mounted when filters match
                  nothing so the operator can clear them; overlay the empty copy. */}
              {filterActive && displayRows.length === 0 ? (
                <Box
                  sx={{
                    position: "absolute",
                    inset: 0,
                    zIndex: 2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    pointerEvents: "none",
                    pt: "40px",
                  }}
                >
                  <EmptyState
                    text="No rows match the active filters"
                    testId="trace-empty-filtered"
                  />
                </Box>
              ) : null}
              <Box
                sx={TABLE_WRAP_SX}
                data-testid="trace-table"
                data-trace-mode={mode}
                data-row-total={displayRows.length}
              >
                <TableVirtuoso
                  data={displayRows as TraceFrame[]}
                  context={tableContext}
                  // Default 32 px; drop fixed height so an open dissection row can grow.
                  defaultItemHeight={32}
                  components={tableComponents}
                  fixedHeaderContent={() => renderHeader(columns, filter, openFilter)}
                  itemContent={rowContent}
                  // Sequential mode auto-follows the tail while scrolled to the
                  // bottom (SRS_visual_ui §5.2); Fixed rewrites in place — no follow.
                  followOutput={mode === "sequential" ? "auto" : false}
                  style={{ height: "100%" }}
                />
              </Box>
            </Box>
          )}
          {filterColumn !== null ? (
            <TraceFilterPopover
              open={filterAnchor !== null}
              anchorEl={filterAnchor}
              column={filterColumn}
              options={filterOptions}
              committed={committedKeys(filter, filterColumn)}
              onApply={applyColumnFilter}
              onCancel={closeFilter}
            />
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
