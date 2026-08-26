import {
  Badge,
  Box,
  Chip,
  IconButton,
  MenuItem,
  TextField,
  Tooltip,
} from "@mui/material";
import type { SxProps } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import FilterListIcon from "@mui/icons-material/FilterList";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import TuneIcon from "@mui/icons-material/Tune";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TableVirtuoso } from "react-virtuoso";
import type { TableComponents } from "react-virtuoso";
import { EmptyState } from "../components/EmptyState";
import { useViewLifecycle } from "../shell/viewLifecycle";
import {
  buildCaptureSource,
  captureButtonLabel,
  DEFAULT_SIM_ADDR,
  linkChipColorVar,
  linkChipLabel,
  showLinkStatusChip,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
  type CaptureLinkStatus,
  type SourceKind,
} from "../runtime/captureSource";
import {
  ackFrames,
  isDesktop,
  onCaptureLink,
  onCaptureSession,
  onFrameBatch,
  startCapture,
  stopCapture,
} from "../runtime/desktop";
import { setSessionEndpoints } from "../runtime/frameModel";
import { traceStore } from "../runtime/traceStore";
import type { TraceFrame } from "../runtime/frameModel";

// ---------------------------------------------------------------------------
// Columns (SRS_visual_ui.md §5.2). Sequential mode — the Pin column belongs to
// fixed mode only and is omitted here.
// ---------------------------------------------------------------------------

interface ColumnDef {
  id: string;
  label: string;
  width: number;
  align: "left" | "right" | "center";
  filter?: { testId: string; label: string };
}

const COLUMNS: ColumnDef[] = [
  { id: "expand", label: "", width: 40, align: "center" },
  { id: "time", label: "Time", width: 120, align: "right" },
  { id: "dir", label: "Dir", width: 70, align: "left" },
  { id: "source", label: "Source", width: 90, align: "left" },
  { id: "protocol", label: "Protocol", width: 90, align: "left" },
  {
    id: "svcmethod",
    label: "Service:Method",
    width: 130,
    align: "right",
    filter: { testId: "trace-filter-service-btn", label: "Filter services" },
  },
  {
    id: "name",
    label: "Name",
    width: 200,
    align: "left",
    filter: { testId: "trace-filter-name-btn", label: "Filter names" },
  },
  { id: "type", label: "Type", width: 70, align: "left" },
  { id: "session", label: "Session", width: 70, align: "right" },
  { id: "length", label: "Length", width: 70, align: "right" },
  { id: "payload", label: "Payload", width: 300, align: "left" },
  { id: "dglobal", label: "Δ global", width: 100, align: "right" },
  { id: "dkey", label: "Δ per key", width: 100, align: "right" },
  { id: "channel", label: "Ch", width: 50, align: "right" },
];

const TABLE_MIN_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);

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
};

const SOURCE_BAR_SX: SxProps = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  px: 1,
  py: 0.75,
  minHeight: 40,
  backgroundColor: "var(--surface-raised)",
  borderBottom: "1px solid var(--border)",
  flexShrink: 0,
};

const COMPACT_FIELD_SX: SxProps = {
  minWidth: 150,
  "& .MuiInputBase-root": { fontSize: 13, height: 32 },
  "& .MuiInputLabel-root": { fontSize: 13 },
};

// ---------------------------------------------------------------------------
// Table pieces (module-level: no per-render identity churn on the hot path)
// ---------------------------------------------------------------------------

const tableComponents: TableComponents<TraceFrame> = {
  Table: ({ style, children, context: _context, ...rest }) => (
    <table
      {...rest}
      style={{
        ...style,
        tableLayout: "fixed",
        borderCollapse: "separate",
        borderSpacing: 0,
        minWidth: TABLE_MIN_WIDTH,
      }}
    >
      <colgroup>
        {COLUMNS.map((c) => (
          <col key={c.id} style={{ width: c.width }} />
        ))}
      </colgroup>
      {children}
    </table>
  ),
};

function renderFixedHeader(): ReactNode {
  return (
    <tr>
      {COLUMNS.map((c) => (
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
                  data-testid={c.filter.testId}
                  sx={{ p: "2px", color: "text.secondary" }}
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

function rowContent(_index: number, f: TraceFrame): ReactNode {
  return (
    <>
      <td style={{ textAlign: "center", padding: 0 }}>
        <Tooltip title="Expand row">
          <IconButton
            size="small"
            aria-label="Expand row"
            data-testid={`trace-expand-btn-${f.id}`}
            sx={{ p: "2px", color: "text.secondary", transition: "none" }}
          >
            <ChevronRightIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </td>
      <td style={MONO_RIGHT}>{f.time}</td>
      <td style={{ color: f.dir === "rx" ? "var(--info)" : "var(--accent-secondary)" }}>
        {f.dir === "rx" ? "Rx" : "Tx"}
      </td>
      <td title={f.sourceTitle}>{f.source}</td>
      <td>{f.protocol}</td>
      <td style={MONO_RIGHT}>{f.serviceMethod}</td>
      <td>{f.name}</td>
      <td>{f.type}</td>
      <td style={MONO_RIGHT}>{f.session}</td>
      <td style={MONO_RIGHT}>{f.length}</td>
      <td style={MONO}>{f.payload}</td>
      <td style={MONO_RIGHT}>{f.deltaGlobal}</td>
      <td style={MONO_RIGHT}>{f.deltaKey}</td>
      <td style={MONO_RIGHT}>{f.channel}</td>
    </>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function TraceView() {
  useViewLifecycle("trace", {});
  const desktop = isDesktop();
  const [capturing, setCapturing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind>("devgen");
  const [simAddr, setSimAddr] = useState(DEFAULT_SIM_ADDR);
  const [linkStatus, setLinkStatus] = useState<CaptureLinkStatus | null>(null);
  const snap = useSyncExternalStore(traceStore.subscribe, traceStore.getSnapshot);
  const frames = snap.rows;
  const controlsLocked = sourceControlsDisabled(capturing);
  const simOk = simSourceAvailable(desktop);

  // Live pipeline: subscribe to batches; restore exactly one backpressure
  // credit per animation frame while a capture is active (SRS §1). Keep-alive
  // views stay mounted, so the stream continues across navigation.
  useEffect(() => {
    if (!capturing) return;
    const unsubscribe = onFrameBatch((batch) => traceStore.ingest(batch));
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

  useEffect(() => {
    const offSession = onCaptureSession(() => {
      /* endpoints applied inside desktop.ts */
    });
    const offLink = onCaptureLink((status) => setLinkStatus(status));
    return () => {
      offSession();
      offLink();
    };
  }, []);

  const toggleCapture = (): void => {
    if (capturing) {
      setCapturing(false);
      setLinkStatus(null);
      setSessionEndpoints(null);
      void stopCapture().catch(() => {
        /* session already gone */
      });
    } else {
      const source = buildCaptureSource(sourceKind, { addr: simAddr });
      if (source.kind === "sim") {
        setLinkStatus({ state: "connecting", detail: source.addr });
      } else {
        setLinkStatus(null);
      }
      startCapture(source)
        .then(() => setCapturing(true))
        .catch(() => {
          // Browser rejects sim; a concurrent desktop session still counts as live.
          if (source.kind === "sim" && !desktop) {
            setCapturing(false);
            setLinkStatus(null);
            return;
          }
          setCapturing(true);
        });
    }
  };

  const togglePause = (): void => {
    setPaused((v) => {
      traceStore.setPaused(!v);
      return !v;
    });
  };

  const captureLabel = captureButtonLabel(capturing, sourceKind);
  const pauseLabel = paused ? "Resume" : "Pause";
  const catalogLabel = catalogLoaded ? "Unload service catalog" : "Load service catalog";
  const clearLabel = frames.length > 0 ? "Clear trace" : "Trace is already empty";
  const chipColor = linkStatus ? linkChipColorVar(linkStatus.state) : "var(--text-secondary)";

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
              onClick={toggleCapture}
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
              data-testid="trace-display-settings-btn"
              sx={{ color: "text.secondary" }}
            >
              <TuneIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={RAIL_SLOT_SX}>
          <Tooltip title={catalogLabel} placement="right">
            <IconButton
              size="small"
              aria-label={catalogLabel}
              aria-pressed={catalogLoaded}
              onClick={() => setCatalogLoaded((v) => !v)}
              data-testid="trace-catalog-btn"
              sx={{ color: "text.secondary" }}
            >
              <Badge
                variant="dot"
                overlap="circular"
                invisible={!catalogLoaded}
                sx={{
                  "& .MuiBadge-badge": {
                    backgroundColor: "var(--success)",
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
                disabled={frames.length === 0}
                onClick={() => traceStore.clear()}
                data-testid="trace-clear-btn"
                sx={{ color: "text.secondary" }}
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* Table region + compact source strip */}
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
        <Box sx={SOURCE_BAR_SX} data-testid="trace-source-bar">
          <TextField
            select
            size="small"
            label="Source"
            value={sourceKind}
            disabled={controlsLocked}
            onChange={(e) => {
              const next = e.target.value as SourceKind;
              if (next === "sim" && !simOk) return;
              setSourceKind(next);
              if (next === "devgen") setLinkStatus(null);
            }}
            sx={COMPACT_FIELD_SX}
            data-testid="trace-source-select"
          >
            <MenuItem value="devgen" data-testid="trace-source-option-devgen">
              Dev generator
            </MenuItem>
            <MenuItem
              value="sim"
              disabled={!simOk}
              title={simOk ? undefined : "desktop app only"}
              data-testid="trace-source-option-sim"
            >
              Simulator link
            </MenuItem>
          </TextField>
          {showSimAddressField(sourceKind) ? (
            <TextField
              size="small"
              label="Address"
              value={simAddr}
              disabled={controlsLocked}
              onChange={(e) => setSimAddr(e.target.value)}
              sx={{ ...COMPACT_FIELD_SX, minWidth: 180, flex: "0 1 220px" }}
              inputProps={{
                "aria-label": "Simulator monitor address",
                style: { fontFamily: "var(--font-mono)", fontSize: 13 },
              }}
              data-testid="trace-sim-addr"
            />
          ) : null}
          {showLinkStatusChip(sourceKind) && linkStatus ? (
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
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
          {paused ? (
            <>
              {/* Paused tri-indicator, parts 2 and 3 (VU-015): warning rule along
                  the table's top edge + warning-outlined chip at its top-right. */}
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
              <Chip
                size="small"
                variant="outlined"
                label={`Paused · ${snap.pausedBuffered} buffered`}
                data-testid="trace-paused-chip"
                sx={{
                  position: "absolute",
                  top: 10,
                  right: 20,
                  zIndex: 3,
                  height: 22,
                  fontSize: 12,
                  color: "var(--warning)",
                  borderColor: "var(--warning)",
                  backgroundColor: "var(--surface-raised-2)",
                }}
              />
            </>
          ) : null}
          {frames.length === 0 ? (
            <EmptyState
              text="No frames captured — start the capture or resume the trace"
              testId="trace-empty"
            />
          ) : (
            <Box sx={TABLE_WRAP_SX} data-testid="trace-table">
              <TableVirtuoso
                data={frames}
                fixedItemHeight={32}
                components={tableComponents}
                fixedHeaderContent={renderFixedHeader}
                itemContent={rowContent}
                style={{ height: "100%" }}
              />
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
