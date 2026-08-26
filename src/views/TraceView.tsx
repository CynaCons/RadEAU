import { Badge, Box, Chip, IconButton, Tooltip } from "@mui/material";
import type { SxProps } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import FilterListIcon from "@mui/icons-material/FilterList";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import TuneIcon from "@mui/icons-material/Tune";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { TableVirtuoso } from "react-virtuoso";
import type { TableComponents } from "react-virtuoso";
import { EmptyState } from "../components/EmptyState";
import { useViewLifecycle } from "../shell/viewLifecycle";

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
// Mock data — deterministic frames from the SOME/IP sensor-fusion network,
// replaced by the live frame stream when the core lands (PRD §3.4).
// ---------------------------------------------------------------------------

interface TraceFrame {
  id: number;
  time: string;
  dir: "rx" | "tx";
  source: string;
  protocol: string;
  serviceMethod: string;
  name: string;
  type: string;
  session: string;
  length: string;
  payload: string;
  deltaGlobal: string;
  deltaKey: string;
  channel: string;
}

interface ServiceDef {
  svc: number;
  method: number;
  name: string;
  eventName: string;
  src: string;
  len: number;
  tx: boolean;
}

const FUSION_SERVICES: ServiceDef[] = [
  { svc: 0x1101, method: 0x8001, name: "CameraObjects", eventName: "ObjectList", src: "10.42.0.11", len: 128, tx: false },
  { svc: 0x1102, method: 0x8001, name: "RadarTargets", eventName: "TargetList", src: "10.42.0.12", len: 96, tx: false },
  { svc: 0x1103, method: 0x8001, name: "LidarClusters", eventName: "ClusterList", src: "10.42.0.13", len: 160, tx: false },
  { svc: 0x1104, method: 0x8001, name: "VehicleDynamics", eventName: "DynamicsState", src: "10.42.0.14", len: 48, tx: false },
  { svc: 0x1201, method: 0x8001, name: "FusedObjects", eventName: "FusedObjectList", src: "10.42.0.15", len: 144, tx: true },
];

function hex4(n: number): string {
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

function payloadPreview(seed: number, totalLen: number): string {
  const shown = Math.min(12, totalLen);
  const parts: string[] = [];
  for (let j = 0; j < shown; j += 1) {
    parts.push((((seed + 1) * 37 + j * 29) % 256).toString(16).toUpperCase().padStart(2, "0"));
  }
  return parts.join(" ") + (totalLen > shown ? " …" : "");
}

function buildMockFrames(count: number): TraceFrame[] {
  const frames: TraceFrame[] = [];
  const lastByKey = new Map<string, number>();
  const sessionByKey = new Map<string, number>();
  let t = 3.9184;
  let prev = t;
  for (let i = 0; i < count; i += 1) {
    t += 0.0006 + ((i * 7) % 13) * 0.00025;
    let key: string;
    let dir: "rx" | "tx";
    let source: string;
    let protocol: string;
    let serviceMethod: string;
    let name: string;
    let type: string;
    let len: number;
    let hasSession = true;
    if (i % 23 === 11) {
      // Periodic SD offers on the wildcard service, cycling the ECUs.
      const sd = FUSION_SERVICES[Math.floor(i / 23) % FUSION_SERVICES.length];
      key = `sd:${sd.svc}`;
      dir = sd.tx ? "tx" : "rx";
      source = sd.src;
      protocol = "SD";
      serviceMethod = `${hex4(0xffff)}:${hex4(0x8100)}`;
      name = `OfferService · ${sd.name}`;
      type = "Offer";
      len = 60;
    } else if (i % 16 === 5) {
      // gPTP Sync from the grandmaster.
      key = "gptp";
      dir = "rx";
      source = "10.42.0.11";
      protocol = "gPTP";
      serviceMethod = "--";
      name = "Sync · GM 10.42.0.11";
      type = "Sync";
      len = 44;
      hasSession = false;
    } else {
      const s = FUSION_SERVICES[i % FUSION_SERVICES.length];
      key = `${s.svc}:${s.method}`;
      dir = s.tx ? "tx" : "rx";
      source = s.src;
      protocol = "SOME/IP";
      serviceMethod = `${hex4(s.svc)}:${hex4(s.method)}`;
      name = `${s.name}.${s.eventName}`;
      type = "Event";
      len = s.len + ((i * 3) % 4) * 8;
    }
    let session = "--";
    if (hasSession) {
      const n = (sessionByKey.get(key) ?? 0) + 1;
      sessionByKey.set(key, n);
      session = String(n);
    }
    const last = lastByKey.get(key);
    lastByKey.set(key, t);
    frames.push({
      id: i,
      time: t.toFixed(4),
      dir,
      source,
      protocol,
      serviceMethod,
      name,
      type,
      session,
      length: String(len),
      payload: payloadPreview(i, len),
      deltaGlobal: i === 0 ? "--" : (t - prev).toFixed(4),
      deltaKey: last === undefined ? "--" : (t - last).toFixed(4),
      channel: "1",
    });
    prev = t;
  }
  return frames;
}

const MOCK_FRAMES = buildMockFrames(150);

/** Mock buffered-while-paused count; live streaming supplies the real one. */
const PAUSED_BUFFERED = 128;

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
      <td>{f.source}</td>
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
  const [paused, setPaused] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [frames, setFrames] = useState<TraceFrame[]>(() => MOCK_FRAMES);

  const pauseLabel = paused ? "Resume" : "Pause";
  const catalogLabel = catalogLoaded ? "Unload service catalog" : "Load service catalog";
  const clearLabel = frames.length > 0 ? "Clear trace" : "Trace is already empty";

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
              onClick={() => setPaused((v) => !v)}
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
                onClick={() => setFrames([])}
                data-testid="trace-clear-btn"
                sx={{ color: "text.secondary" }}
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Box>

      {/* Table region */}
      <Box sx={{ flex: 1, minWidth: 0, position: "relative", backgroundColor: "var(--surface-canvas)" }}>
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
              label={`Paused · ${PAUSED_BUFFERED} buffered`}
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
            text="No frames captured — resume the trace or start a session"
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
  );
}
