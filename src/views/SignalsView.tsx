import {
  Box,
  ButtonBase,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Popover,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CropFreeIcon from "@mui/icons-material/CropFree";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import DownloadIcon from "@mui/icons-material/Download";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FitScreenIcon from "@mui/icons-material/FitScreen";
import LinkIcon from "@mui/icons-material/Link";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import OpenWithIcon from "@mui/icons-material/OpenWith";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ScatterPlotIcon from "@mui/icons-material/ScatterPlot";
import SettingsIcon from "@mui/icons-material/Settings";
import SplitscreenIcon from "@mui/icons-material/Splitscreen";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import ViewSidebarIcon from "@mui/icons-material/ViewSidebar";
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { EmptyState } from "../components/EmptyState";
import { useViewLifecycle } from "../shell/viewLifecycle";

// ── Mock decodable-service catalog ───────────────────────────────────────────
// Deterministic placeholder for the SOME/IP sensor-fusion network (PRD §3.4);
// replaced by the live service catalog when decoding lands.

interface MockSignal {
  name: string;
  unit: string;
}
interface MockEvent {
  name: string;
  id: number;
  signals: MockSignal[];
}
interface MockService {
  name: string;
  id: number;
  provider: string;
  events: MockEvent[];
}

const SERVICES: MockService[] = [
  {
    name: "CameraObjects",
    id: 0x1101,
    provider: "10.42.0.11",
    events: [
      {
        name: "ObjectList",
        id: 0x8001,
        signals: [
          { name: "objectCount", unit: "" },
          { name: "ttcMin", unit: "s" },
          { name: "laneOffset", unit: "m" },
        ],
      },
      {
        name: "CameraStatus",
        id: 0x8002,
        signals: [
          { name: "exposureTime", unit: "ms" },
          { name: "frameRate", unit: "fps" },
        ],
      },
    ],
  },
  {
    name: "RadarTargets",
    id: 0x1102,
    provider: "10.42.0.12",
    events: [
      {
        name: "TargetList",
        id: 0x8001,
        signals: [
          { name: "targetCount", unit: "" },
          { name: "nearestRange", unit: "m" },
          { name: "nearestVelocity", unit: "m/s" },
        ],
      },
      {
        name: "RadarHealth",
        id: 0x8002,
        signals: [
          { name: "blockageLevel", unit: "%" },
          { name: "housingTemp", unit: "degC" },
        ],
      },
    ],
  },
  {
    name: "LidarClusters",
    id: 0x1103,
    provider: "10.42.0.13",
    events: [
      {
        name: "ClusterList",
        id: 0x8001,
        signals: [
          { name: "clusterCount", unit: "" },
          { name: "groundHeight", unit: "m" },
        ],
      },
      {
        name: "SensorPose",
        id: 0x8002,
        signals: [
          { name: "pitchAngle", unit: "deg" },
          { name: "rollAngle", unit: "deg" },
        ],
      },
    ],
  },
  {
    name: "VehicleDynamics",
    id: 0x1104,
    provider: "10.42.0.14",
    events: [
      {
        name: "Motion",
        id: 0x8001,
        signals: [
          { name: "vehicleSpeed", unit: "km/h" },
          { name: "yawRate", unit: "deg/s" },
          { name: "longAccel", unit: "m/s2" },
          { name: "latAccel", unit: "m/s2" },
        ],
      },
      {
        name: "SteeringWheel",
        id: 0x8002,
        signals: [
          { name: "steeringAngle", unit: "deg" },
          { name: "steeringTorque", unit: "Nm" },
        ],
      },
    ],
  },
  {
    name: "FusedObjects",
    id: 0x1201,
    provider: "10.42.0.20",
    events: [
      {
        name: "FusedList",
        id: 0x8001,
        signals: [
          { name: "fusedCount", unit: "" },
          { name: "egoLaneObjects", unit: "" },
        ],
      },
      {
        name: "FusionStatus",
        id: 0x8002,
        signals: [
          { name: "pipelineLatency", unit: "ms" },
          { name: "confidence", unit: "%" },
        ],
      },
    ],
  },
];

const hex4 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(4, "0")}`;
const hexKey = (v: number) => v.toString(16).padStart(4, "0");
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// ── Shared styles ────────────────────────────────────────────────────────────

const smallToggleSx = {
  height: 22,
  px: "8px",
  py: 0,
  fontSize: 11,
  textTransform: "none",
  color: "text.secondary",
  "&.Mui-selected": { color: "var(--accent-primary)", bgcolor: "var(--fill-subtle)" },
} as const;

const monoSx = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
} as const;

const ellipsisSx = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

// ── Small building blocks ────────────────────────────────────────────────────

/** Icon-only toolbar control (§5.1): tooltip = aria-label; active toggles take
 * an accent-primary glyph over a fill-subtle fill; disabled keeps a tooltip
 * naming the precondition (§7.3). */
function ToolIconButton(props: {
  title: string;
  testId: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  disabledReason?: string;
  pressed?: boolean;
  glyphColor?: string;
  iconSize?: number;
  children: ReactNode;
}) {
  const { title, testId, onClick, disabled, disabledReason, pressed, glyphColor, iconSize, children } = props;
  const tooltip = disabled && disabledReason ? disabledReason : title;
  return (
    <Tooltip title={tooltip}>
      <span style={{ display: "inline-flex" }}>
        <IconButton
          size="small"
          onClick={onClick}
          disabled={disabled}
          aria-label={title}
          {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
          data-testid={testId}
          sx={{
            borderRadius: 1,
            p: "4px",
            color: glyphColor ?? (pressed ? "var(--accent-primary)" : "var(--text-secondary)"),
            bgcolor: pressed ? "var(--fill-subtle)" : "transparent",
            "& svg": { fontSize: iconSize ?? 18 },
          }}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}

/** Full-height 1 px divider between toolbar clusters (§5.1). */
function ClusterDivider() {
  return <Box sx={{ width: "1px", alignSelf: "stretch", bgcolor: "var(--border)", flexShrink: 0 }} />;
}

/** Bordered time-domain plot placeholder on surface-canvas; the real chart
 * engine arrives in v0.2. Drop target washes to fill-subtle (§7.4). */
function PlotPane(props: { testId: string; emptyTestId: string }) {
  const { testId, emptyTestId } = props;
  const [dragOver, setDragOver] = useState(false);
  return (
    <Box
      data-testid={testId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
      }}
      sx={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        border: "1px solid var(--border)",
        bgcolor: dragOver ? "var(--fill-subtle)" : "var(--surface-canvas)",
      }}
    >
      <EmptyState inset text="Drag signals here to plot" testId={emptyTestId} />
    </Box>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

export function SignalsView() {
  useViewLifecycle("signals", {});

  // Explorer
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [format, setFormat] = useState<"hex" | "dec">("hex");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(["svc-1101", "svc-1101/ev-8001"]),
  );
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  // Layout
  const [split, setSplit] = useState(false);
  const [legendVisible, setLegendVisible] = useState(true);
  const [cursorValues, setCursorValues] = useState(true);
  const [tab, setTab] = useState<"time" | "fft">("time");

  // Plotter toolbar
  const [paused, setPaused] = useState(false);
  const [zoomMode, setZoomMode] = useState<"x" | "y" | "xy">("x");
  const [autoscale, setAutoscale] = useState(false);
  const [sharedCursor, setSharedCursor] = useState(false);
  const [liveFollow, setLiveFollow] = useState(true);
  const [sampleMarkers, setSampleMarkers] = useState(false);
  const [rendererPref, setRendererPref] = useState<"auto" | "webgl" | "canvas">("auto");
  const [configAnchor, setConfigAnchor] = useState<HTMLElement | null>(null);

  // FFT
  const [fftAuto, setFftAuto] = useState(true);
  const [fftLength, setFftLength] = useState("2048");
  const [fftWindow, setFftWindow] = useState("hann");

  const fmtId = (v: number) => (format === "hex" ? hex4(v) : String(v));
  const toggleNode = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rateField = (
    <TextField
      size="small"
      fullWidth
      label="Sample rate (Hz)"
      defaultValue="100.0"
      disabled={fftAuto}
      helperText="Estimated 100.0 Hz from stream timing"
      inputProps={{ "aria-label": "Sample rate in hertz", sx: monoSx }}
      data-testid="signals-fft-rate-field"
    />
  );

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
      {/* ── Source explorer ─────────────────────────────────────────────── */}
      <Box
        data-testid="signals-explorer"
        sx={{
          width: explorerCollapsed ? 50 : 340,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          bgcolor: "var(--surface-raised)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {explorerCollapsed ? (
          <Stack alignItems="center" spacing={0.5} sx={{ pt: "8px" }}>
            <ToolIconButton
              title="Expand explorer"
              testId="signals-explorer-collapse-btn"
              onClick={() => setExplorerCollapsed(false)}
            >
              <ChevronRightIcon />
            </ToolIconButton>
            <ToolIconButton
              title={split ? "Merge plot panes" : "Split plot panes"}
              testId="signals-split-toggle"
              pressed={split}
              onClick={() => setSplit((v) => !v)}
            >
              <SplitscreenIcon />
            </ToolIconButton>
          </Stack>
        ) : (
          <>
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ p: "8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}
            >
              <ToggleButtonGroup
                size="small"
                exclusive
                value={format}
                onChange={(_, v: "hex" | "dec" | null) => {
                  if (v) setFormat(v);
                }}
                aria-label="Identifier format"
              >
                <ToggleButton value="hex" sx={smallToggleSx} data-testid="signals-format-hex">
                  Hex
                </ToggleButton>
                <ToggleButton value="dec" sx={smallToggleSx} data-testid="signals-format-dec">
                  Dec
                </ToggleButton>
              </ToggleButtonGroup>
              <Box sx={{ flex: 1 }} />
              <ToolIconButton
                title={split ? "Merge plot panes" : "Split plot panes"}
                testId="signals-split-toggle"
                pressed={split}
                onClick={() => setSplit((v) => !v)}
              >
                <SplitscreenIcon />
              </ToolIconButton>
              <ToolIconButton
                title="Collapse explorer"
                testId="signals-explorer-collapse-btn"
                onClick={() => setExplorerCollapsed(true)}
              >
                <ChevronLeftIcon />
              </ToolIconButton>
            </Stack>

            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", py: "4px" }}>
              {SERVICES.map((svc) => {
                const svcHex = hexKey(svc.id);
                const svcKey = `svc-${svcHex}`;
                const svcOpen = expanded.has(svcKey);
                return (
                  <Box key={svcKey}>
                    <ButtonBase
                      onClick={() => toggleNode(svcKey)}
                      aria-expanded={svcOpen}
                      data-testid={`signals-explorer-service-${svcHex}`}
                      sx={{
                        width: "100%",
                        justifyContent: "flex-start",
                        gap: "6px",
                        height: 28,
                        px: "8px",
                        "&:hover": { bgcolor: "var(--fill-subtle)" },
                      }}
                    >
                      {svcOpen ? (
                        <ExpandMoreIcon sx={{ fontSize: 16, color: "var(--text-secondary)" }} />
                      ) : (
                        <ChevronRightIcon sx={{ fontSize: 16, color: "var(--text-secondary)" }} />
                      )}
                      <Typography sx={{ fontSize: 13, fontWeight: 500, ...ellipsisSx }}>
                        {svc.name}
                      </Typography>
                      <Typography
                        sx={{ ml: "auto", ...monoSx, fontSize: 12, color: "text.secondary" }}
                      >
                        {fmtId(svc.id)}
                      </Typography>
                      <Typography sx={{ ...monoSx, fontSize: 11, color: "var(--text-tertiary)" }}>
                        {svc.provider}
                      </Typography>
                    </ButtonBase>
                    {svcOpen
                      ? svc.events.map((ev) => {
                          const evHex = hexKey(ev.id);
                          const evKey = `${svcKey}/ev-${evHex}`;
                          const evOpen = expanded.has(evKey);
                          return (
                            <Box key={evKey}>
                              <ButtonBase
                                onClick={() => toggleNode(evKey)}
                                aria-expanded={evOpen}
                                data-testid={`signals-explorer-event-${svcHex}-${evHex}`}
                                sx={{
                                  width: "100%",
                                  justifyContent: "flex-start",
                                  gap: "6px",
                                  height: 26,
                                  pl: "28px",
                                  pr: "8px",
                                  "&:hover": { bgcolor: "var(--fill-subtle)" },
                                }}
                              >
                                {evOpen ? (
                                  <ExpandMoreIcon
                                    sx={{ fontSize: 16, color: "var(--text-secondary)" }}
                                  />
                                ) : (
                                  <ChevronRightIcon
                                    sx={{ fontSize: 16, color: "var(--text-secondary)" }}
                                  />
                                )}
                                <Typography sx={{ fontSize: 13, ...ellipsisSx }}>{ev.name}</Typography>
                                <Typography
                                  sx={{ ml: "auto", ...monoSx, fontSize: 12, color: "text.secondary" }}
                                >
                                  {fmtId(ev.id)}
                                </Typography>
                              </ButtonBase>
                              {evOpen
                                ? ev.signals.map((sig) => {
                                    const sigKey = `${evKey}/${sig.name}`;
                                    return (
                                      <Box
                                        key={sigKey}
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.setData(
                                            "text/plain",
                                            `${svc.name}.${ev.name}.${sig.name}`,
                                          );
                                          setDraggingKey(sigKey);
                                        }}
                                        onDragEnd={() => setDraggingKey(null)}
                                        data-testid={`signals-explorer-signal-${svcHex}-${evHex}-${kebab(sig.name)}`}
                                        sx={{
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "6px",
                                          height: 26,
                                          pl: "48px",
                                          pr: "8px",
                                          cursor: "grab",
                                          opacity: draggingKey === sigKey ? 0.4 : 1,
                                          "&:hover": { bgcolor: "var(--fill-subtle)" },
                                        }}
                                      >
                                        <DragIndicatorIcon
                                          sx={{ fontSize: 14, color: "var(--text-tertiary)" }}
                                        />
                                        <Typography sx={{ fontSize: 13, ...ellipsisSx }}>
                                          {sig.name}
                                        </Typography>
                                        {sig.unit !== "" ? (
                                          <Typography
                                            sx={{
                                              ml: "auto",
                                              fontSize: 9.6,
                                              fontStyle: "italic",
                                              color: "text.secondary",
                                            }}
                                          >
                                            {sig.unit}
                                          </Typography>
                                        ) : null}
                                      </Box>
                                    );
                                  })
                                : null}
                            </Box>
                          );
                        })
                      : null}
                  </Box>
                );
              })}
            </Box>
          </>
        )}
      </Box>

      {/* ── Legend panel — exactly 180 px when empty (VU-011) ───────────── */}
      <Box
        data-testid="signals-legend-panel"
        sx={{
          width: 180,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          bgcolor: "var(--surface-raised)",
          display: legendVisible ? "flex" : "none",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <Box sx={{ p: "8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>Signals (0)</Typography>
            <Box sx={{ flex: 1 }} />
            <Typography
              data-testid="signals-cursor-readout"
              sx={{
                fontSize: 11.2,
                fontWeight: 700,
                color: "var(--accent-primary)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              --
            </Typography>
          </Stack>
          <Stack direction="row" justifyContent="flex-end" spacing={0.5}>
            <ToolIconButton
              title="Hide legend panel"
              testId="signals-legend-visibility-toggle"
              pressed={legendVisible}
              iconSize={14}
              onClick={() => setLegendVisible(false)}
            >
              <ViewSidebarIcon />
            </ToolIconButton>
            <ToolIconButton
              title={cursorValues ? "Hide cursor values" : "Show cursor values"}
              testId="signals-legend-cursor-toggle"
              pressed={cursorValues}
              iconSize={14}
              onClick={() => setCursorValues((v) => !v)}
            >
              <MyLocationIcon />
            </ToolIconButton>
          </Stack>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
          <EmptyState
            text="No signals plotted — drag from the explorer"
            testId="signals-legend-empty"
          />
        </Box>
      </Box>

      {/* ── Plot stack ──────────────────────────────────────────────────── */}
      <Box
        data-testid="signals-plot-stack"
        sx={{ flex: 1, minWidth: 320, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        <Tabs
          value={tab}
          onChange={(_, v: "time" | "fft") => setTab(v)}
          sx={{
            minHeight: 36,
            height: 36,
            pl: "8px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            "& .MuiTabs-indicator": { bgcolor: "var(--accent-primary)" },
          }}
        >
          <Tab
            label="Time"
            value="time"
            data-testid="signals-tab-time"
            sx={{ minHeight: 36, py: 0, minWidth: 64, fontSize: 13, textTransform: "none" }}
          />
          <Tab
            label="FFT"
            value="fft"
            data-testid="signals-tab-fft"
            sx={{ minHeight: 36, py: 0, minWidth: 64, fontSize: 13, textTransform: "none" }}
          />
        </Tabs>

        {/* ── Time panel — stays mounted (§5.1) ─────────────────────────── */}
        <Box
          data-testid="signals-time-panel"
          sx={{
            flex: 1,
            minHeight: 0,
            display: tab === "time" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          {/* Plotter toolbar: one row, 8 px padding, 8 px gaps, 1 px bottom rule */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{
              p: "8px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              overflowX: "auto",
            }}
          >
            {/* Transport */}
            <Typography sx={{ fontSize: 12, fontWeight: 500, color: "text.secondary", whiteSpace: "nowrap" }}>
              Pane 1
            </Typography>
            <ToolIconButton
              title={paused ? "Resume plotting" : "Pause plotting"}
              testId="plotter-pause-btn"
              pressed={paused}
              glyphColor={paused ? "var(--warning)" : undefined}
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? <PlayArrowIcon /> : <PauseIcon />}
            </ToolIconButton>
            <ClusterDivider />

            {/* Zoom mode — exclusive, default X */}
            <ToolIconButton
              title="Zoom X axis only"
              testId="plotter-zoom-mode-x"
              pressed={zoomMode === "x"}
              onClick={() => setZoomMode("x")}
            >
              <SwapHorizIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Zoom Y axis only"
              testId="plotter-zoom-mode-y"
              pressed={zoomMode === "y"}
              onClick={() => setZoomMode("y")}
            >
              <SwapVertIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Zoom both axes"
              testId="plotter-zoom-mode-xy"
              pressed={zoomMode === "xy"}
              onClick={() => setZoomMode("xy")}
            >
              <OpenWithIcon />
            </ToolIconButton>
            <ClusterDivider />

            {/* View */}
            <ToolIconButton
              title="Fit all signals"
              testId="plotter-fit-all-btn"
              disabled
              disabledReason="No signals plotted"
            >
              <FitScreenIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Window autoscale"
              testId="plotter-autoscale-toggle"
              pressed={autoscale}
              onClick={() => setAutoscale((v) => !v)}
            >
              <CropFreeIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Shared cursor"
              testId="plotter-shared-cursor-toggle"
              pressed={sharedCursor}
              onClick={() => setSharedCursor((v) => !v)}
            >
              <LinkIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Live follow"
              testId="plotter-live-follow-toggle"
              pressed={liveFollow}
              onClick={() => setLiveFollow((v) => !v)}
            >
              <AutorenewIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Sample markers"
              testId="plotter-sample-markers-toggle"
              pressed={sampleMarkers}
              onClick={() => setSampleMarkers((v) => !v)}
            >
              <ScatterPlotIcon />
            </ToolIconButton>
            <ClusterDivider />

            {/* Session */}
            <ToolIconButton
              title="Clear plotted data"
              testId="plotter-clear-btn"
              disabled
              disabledReason="No signals plotted"
            >
              <DeleteSweepIcon />
            </ToolIconButton>
            <ToolIconButton title="Reset renderer" testId="plotter-reset-renderer-btn">
              <RestartAltIcon />
            </ToolIconButton>
            <ToolIconButton
              title="Export plotted data"
              testId="plotter-export-btn"
              disabled
              disabledReason="No data to export"
            >
              <DownloadIcon />
            </ToolIconButton>
            <ClusterDivider />

            {/* Config */}
            <ToolIconButton
              title="Plotter settings"
              testId="plotter-config-btn"
              onClick={(e) => setConfigAnchor(e.currentTarget)}
            >
              <SettingsIcon />
            </ToolIconButton>
            <Popover
              open={configAnchor !== null}
              anchorEl={configAnchor}
              onClose={() => setConfigAnchor(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
            >
              <Box sx={{ width: 250, p: "12px" }} data-testid="plotter-config-menu">
                <Stack spacing={1.5}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Switch
                      size="small"
                      defaultChecked
                      inputProps={{ "aria-label": "Peak-preserving decimation" }}
                      data-testid="plotter-config-decimation-switch"
                    />
                    <Typography sx={{ fontSize: 13 }}>Peak-preserving decimation</Typography>
                  </Stack>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Switch
                      size="small"
                      inputProps={{ "aria-label": "Snap cursor to samples" }}
                      data-testid="plotter-config-snap-switch"
                    />
                    <Typography sx={{ fontSize: 13 }}>Snap cursor to samples</Typography>
                  </Stack>
                  <TextField
                    size="small"
                    label="Time window (s)"
                    defaultValue="10.0"
                    helperText="Visible span while live follow is on"
                    inputProps={{ "aria-label": "Time window in seconds", sx: monoSx }}
                    data-testid="plotter-config-window-field"
                  />
                  <TextField
                    size="small"
                    label="Redraw rate (fps)"
                    defaultValue="30"
                    helperText="Target renderer refresh rate"
                    inputProps={{ "aria-label": "Redraw rate in frames per second", sx: monoSx }}
                    data-testid="plotter-config-fps-field"
                  />
                </Stack>
              </Box>
            </Popover>
            <ClusterDivider />

            {/* Renderer */}
            <Chip
              label="WebGL"
              size="small"
              variant="outlined"
              data-testid="plotter-renderer-chip"
              sx={{
                height: 22,
                fontSize: 11,
                color: "var(--info)",
                borderColor: "var(--info)",
                flexShrink: 0,
              }}
            />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={rendererPref}
              onChange={(_, v: "auto" | "webgl" | "canvas" | null) => {
                if (v) setRendererPref(v);
              }}
              aria-label="Renderer preference"
              sx={{ flexShrink: 0 }}
            >
              <ToggleButton value="auto" sx={smallToggleSx} data-testid="plotter-renderer-auto">
                Auto
              </ToggleButton>
              <ToggleButton value="webgl" sx={smallToggleSx} data-testid="plotter-renderer-webgl">
                WebGL
              </ToggleButton>
              <ToggleButton value="canvas" sx={smallToggleSx} data-testid="plotter-renderer-canvas">
                Canvas
              </ToggleButton>
            </ToggleButtonGroup>
            <ClusterDivider />

            {/* Layout */}
            <ToolIconButton
              title={legendVisible ? "Hide legend panel" : "Show legend panel"}
              testId="plotter-legend-toggle"
              pressed={legendVisible}
              onClick={() => setLegendVisible((v) => !v)}
            >
              <ViewSidebarIcon />
            </ToolIconButton>
          </Stack>

          {/* Pane(s) */}
          <Box
            sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", p: "8px" }}
          >
            <PlotPane testId="signals-time-pane-1" emptyTestId="signals-time-empty" />
            {split ? (
              <>
                <Box
                  role="separator"
                  aria-label="Resize panes"
                  data-testid="signals-pane-splitter"
                  sx={{ height: "2px", bgcolor: "var(--border)", cursor: "row-resize", flexShrink: 0 }}
                />
                <PlotPane testId="signals-time-pane-2" emptyTestId="signals-time-empty-2" />
              </>
            ) : null}
          </Box>
        </Box>

        {/* ── FFT panel — stays mounted (§5.1) ──────────────────────────── */}
        <Box
          data-testid="signals-fft-panel"
          sx={{ flex: 1, minHeight: 0, display: tab === "fft" ? "flex" : "none" }}
        >
          {/* Configuration rail — 260 px */}
          <Box
            data-testid="signals-fft-config-rail"
            sx={{
              width: 260,
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              bgcolor: "var(--surface-raised)",
              overflowY: "auto",
              p: "12px",
            }}
          >
            <Stack spacing={1.5}>
              <Stack direction="row" alignItems="center">
                <Typography sx={{ fontSize: 12, fontWeight: 500, color: "text.secondary" }}>
                  Spectrum
                </Typography>
                <Box sx={{ flex: 1 }} />
                <ToolIconButton
                  title="Detach spectrum window"
                  testId="signals-fft-detach-btn"
                  iconSize={16}
                >
                  <OpenInNewIcon />
                </ToolIconButton>
              </Stack>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  size="small"
                  checked={fftAuto}
                  onChange={(e) => setFftAuto(e.target.checked)}
                  inputProps={{ "aria-label": "Auto sample rate" }}
                  data-testid="signals-fft-auto-rate-switch"
                />
                <Typography sx={{ fontSize: 13 }}>Auto sample rate</Typography>
              </Stack>
              {fftAuto ? (
                <Tooltip title="Disabled while auto sample rate is on">
                  <span>{rateField}</span>
                </Tooltip>
              ) : (
                rateField
              )}
              <TextField
                select
                size="small"
                label="Transform length"
                value={fftLength}
                onChange={(e) => setFftLength(e.target.value)}
                inputProps={{ "aria-label": "Transform length" }}
                data-testid="signals-fft-length-select"
              >
                {["512", "1024", "2048", "4096", "8192"].map((n) => (
                  <MenuItem key={n} value={n} data-testid={`signals-fft-length-${n}`}>
                    {n}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label="Window function"
                value={fftWindow}
                onChange={(e) => setFftWindow(e.target.value)}
                inputProps={{ "aria-label": "Window function" }}
                data-testid="signals-fft-window-select"
              >
                <MenuItem value="hann" data-testid="signals-fft-window-hann">
                  Hann
                </MenuItem>
                <MenuItem value="hamming" data-testid="signals-fft-window-hamming">
                  Hamming
                </MenuItem>
                <MenuItem value="blackman" data-testid="signals-fft-window-blackman">
                  Blackman-Harris
                </MenuItem>
                <MenuItem value="rect" data-testid="signals-fft-window-rect">
                  Rectangular
                </MenuItem>
              </TextField>
              <Tooltip title="No spectrum data">
                <span>
                  <Button
                    variant="outlined"
                    size="small"
                    disabled
                    data-testid="signals-fft-reset-y-btn"
                  >
                    Reset Y axis
                  </Button>
                </span>
              </Tooltip>
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                Peak frequency: --
              </Typography>
            </Stack>
          </Box>

          {/* Enabled-signal panel — 200 px */}
          <Box
            data-testid="signals-fft-signal-panel"
            sx={{
              width: 200,
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              bgcolor: "var(--surface-raised)",
              position: "relative",
              minHeight: 0,
            }}
          >
            <EmptyState
              text="No FFT signals — enable a plotted signal"
              testId="signals-fft-signals-empty"
            />
          </Box>

          {/* Spectrum placeholder */}
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", p: "8px" }}>
            <Box
              data-testid="signals-fft-spectrum-pane"
              sx={{
                flex: 1,
                minHeight: 0,
                position: "relative",
                border: "1px solid var(--border)",
                bgcolor: "var(--surface-canvas)",
              }}
            >
              <EmptyState
                inset
                text="No spectrum — enable a signal in the Time tab"
                testId="signals-fft-empty"
              />
              <Box
                data-testid="signals-fft-readout-chip"
                sx={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  px: "8px",
                  py: "2px",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  bgcolor: "var(--surface-raised)",
                  ...monoSx,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                }}
              >
                -- Hz · -- dB
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
