import {
  Box,
  ButtonBase,
  Divider,
  IconButton,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SvgIconComponent } from "@mui/icons-material";
import BookmarksIcon from "@mui/icons-material/Bookmarks";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DnsIcon from "@mui/icons-material/Dns";
import DynamicFeedIcon from "@mui/icons-material/DynamicFeed";
import TuneIcon from "@mui/icons-material/Tune";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import { useViewLifecycle } from "../shell/viewLifecycle";

// Secondary rail geometry mirrors the primary rail (SRS_visual_ui.md §5.4/§4.4).
const RAIL_COLLAPSED = 65;
const RAIL_EXPANDED = 240;
const RAIL_TRANSITION = "width 225ms cubic-bezier(0.4, 0, 0.6, 1)";
const LABEL_TRANSITION = "opacity 225ms cubic-bezier(0.4, 0, 0.6, 1)";

interface SimPage {
  id: string;
  label: string;
  icon: SvgIconComponent;
}

const SIM_PAGES: SimPage[] = [
  { id: "node", label: "Node simulation", icon: DnsIcon },
  { id: "signal", label: "Signal simulation", icon: TuneIcon },
  { id: "frame-gen", label: "Frame generation", icon: DynamicFeedIcon },
  { id: "presets", label: "Presets", icon: BookmarksIcon },
];

const EMPTY_PAGE_TEXT: Record<string, string> = {
  node: "No simulated nodes configured — add a node from the loaded service catalog.",
  "frame-gen": "No frame generators defined — create a generator to transmit synthetic frames.",
  presets: "No presets saved — save the current simulation setup to reuse it.",
};

// Mock signal-value overrides — replaced by live simulation state when the
// SOME/IP core lands (PRD §6). Deterministic, sensor-fusion-network plausible.
interface SimSignal {
  id: string;
  name: string;
  service: string;
  serviceId: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  initial: number;
}

const SIM_SIGNALS: SimSignal[] = [
  {
    id: "vehicle-speed",
    name: "VehicleSpeed",
    service: "VehicleDynamics",
    serviceId: 0x1104,
    unit: "km/h",
    min: 0,
    max: 250,
    step: 0.5,
    decimals: 1,
    initial: 82.5,
  },
  {
    id: "yaw-rate",
    name: "YawRate",
    service: "VehicleDynamics",
    serviceId: 0x1104,
    unit: "°/s",
    min: -75,
    max: 75,
    step: 0.1,
    decimals: 1,
    initial: -3.2,
  },
  {
    id: "object-count",
    name: "ObjectCount",
    service: "CameraObjects",
    serviceId: 0x1101,
    unit: "objects",
    min: 0,
    max: 32,
    step: 1,
    decimals: 0,
    initial: 6,
  },
];

const formatServiceId = (id: number) => `0x${id.toString(16).toUpperCase().padStart(4, "0")}`;

// Motion policy (§8): no transitions on slider thumb/track/rail; keyboard
// focus keeps the standard 2 px accent ring (§9) instead of MUI's box-shadow.
const SLIDER_NO_MOTION = {
  "& .MuiSlider-thumb, & .MuiSlider-track, & .MuiSlider-rail": { transition: "none" },
  "& .MuiSlider-thumb:hover, & .MuiSlider-thumb.Mui-active": { boxShadow: "none" },
  "& .MuiSlider-thumb.Mui-focusVisible": {
    boxShadow: "none",
    outline: "2px solid var(--accent-primary)",
    outlineOffset: "2px",
  },
} as const;

export function SimulationView() {
  useViewLifecycle("simulation", {});
  const [railExpanded, setRailExpanded] = useState(true);
  const [activePage, setActivePage] = useState("signal");
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(SIM_SIGNALS.map((s) => [s.id, s.initial])),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(SIM_SIGNALS.map((s) => [s.id, s.initial.toFixed(s.decimals)])),
  );

  // Field is authoritative: commit parses, clamps to range, and writes back
  // the canonical fixed-decimal form; a non-numeric draft reverts.
  const commitDraft = (sig: SimSignal) => {
    const parsed = Number(drafts[sig.id]);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(sig.max, Math.max(sig.min, parsed));
      setValues((v) => ({ ...v, [sig.id]: clamped }));
      setDrafts((d) => ({ ...d, [sig.id]: clamped.toFixed(sig.decimals) }));
    } else {
      setDrafts((d) => ({ ...d, [sig.id]: values[sig.id].toFixed(sig.decimals) }));
    }
  };

  const handleSlider = (sig: SimSignal, value: number | number[]) => {
    const n = Array.isArray(value) ? value[0] : value;
    setValues((v) => ({ ...v, [sig.id]: n }));
    setDrafts((d) => ({ ...d, [sig.id]: n.toFixed(sig.decimals) }));
  };

  const railToggleLabel = railExpanded ? "Collapse simulation rail" : "Expand simulation rail";

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
      <Box
        component="nav"
        aria-label="Simulation"
        data-testid="simulation-rail"
        sx={{
          width: railExpanded ? RAIL_EXPANDED : RAIL_COLLAPSED,
          transition: RAIL_TRANSITION,
          "@media (prefers-reduced-motion: reduce)": { transition: "none" },
          flexShrink: 0,
          bgcolor: "background.paper",
          borderRight: "1px solid var(--border)",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          sx={{
            height: 48,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            pl: railExpanded ? "20px" : 0,
            pr: railExpanded ? "8px" : 0,
            justifyContent: railExpanded ? "space-between" : "center",
          }}
        >
          <Typography
            noWrap
            sx={{
              fontSize: 20,
              fontWeight: 500,
              color: "text.secondary",
              opacity: railExpanded ? 1 : 0,
              width: railExpanded ? "auto" : 0,
              overflow: "hidden",
              transition: LABEL_TRANSITION,
              "@media (prefers-reduced-motion: reduce)": { transition: "none" },
            }}
          >
            Simulation
          </Typography>
          <Tooltip title={railToggleLabel} placement="right">
            <IconButton
              size="small"
              onClick={() => setRailExpanded((e) => !e)}
              aria-label={railToggleLabel}
              aria-pressed={railExpanded}
              data-testid="simulation-rail-toggle"
            >
              {railExpanded ? (
                <ChevronLeftIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Box>
        <Divider />
        {SIM_PAGES.map((page) => {
          const selected = page.id === activePage;
          const Icon = page.icon;
          return (
            <Tooltip key={page.id} title={railExpanded ? "" : page.label} placement="right">
              <ButtonBase
                onClick={() => setActivePage(page.id)}
                aria-label={page.label}
                aria-current={selected ? "page" : undefined}
                data-testid={`simulation-nav-${page.id}`}
                sx={{
                  height: 48,
                  px: "20px",
                  justifyContent: "flex-start",
                  width: "100%",
                  flexShrink: 0,
                  bgcolor: selected ? "var(--fill-subtle)" : "transparent",
                  color: selected ? "var(--accent-primary)" : "var(--text-secondary)",
                  "&:hover": { bgcolor: "var(--fill-subtle)" },
                }}
              >
                <Box sx={{ display: "inline-flex", width: 24, flexShrink: 0 }}>
                  <Icon fontSize="small" />
                </Box>
                <Typography
                  noWrap
                  sx={{
                    ml: "24px",
                    fontSize: 16,
                    color: "inherit",
                    opacity: railExpanded ? 1 : 0,
                    transition: LABEL_TRANSITION,
                    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                  }}
                >
                  {page.label}
                </Typography>
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, overflow: "auto", p: "24px" }}>
        {activePage === "signal" ? (
          <Box sx={{ maxWidth: 800 }}>
            <RaisedPanel
              icon={<TuneIcon sx={{ color: "var(--accent-primary)" }} />}
              title="Signal simulation"
              subtitle="Overrides applied to outgoing frames. The numeric field is authoritative; the slider is a coarse input."
              testId="simulation-signal-panel"
            >
              <Stack spacing={3}>
                {SIM_SIGNALS.map((sig) => (
                  <Box key={sig.id}>
                    <Stack direction="row" alignItems="baseline" spacing={1}>
                      <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{sig.name}</Typography>
                      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                        {sig.service}{" "}
                        <Box
                          component="span"
                          sx={{
                            fontFamily: "var(--font-mono)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatServiceId(sig.serviceId)}
                        </Box>
                      </Typography>
                      <Box sx={{ flex: 1 }} />
                      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                        {sig.unit}
                      </Typography>
                    </Stack>
                    <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 0.5 }}>
                      <Slider
                        size="small"
                        min={sig.min}
                        max={sig.max}
                        step={sig.step}
                        value={values[sig.id]}
                        valueLabelDisplay="off"
                        onChange={(_e, v) => handleSlider(sig, v)}
                        aria-label={`${sig.name} slider`}
                        data-testid={`simulation-signal-${sig.id}-slider`}
                        sx={{ flex: 1, ...SLIDER_NO_MOTION }}
                      />
                      <TextField
                        size="small"
                        value={drafts[sig.id]}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [sig.id]: e.target.value }))
                        }
                        onBlur={() => commitDraft(sig)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitDraft(sig);
                        }}
                        inputProps={{
                          "aria-label": `${sig.name} value`,
                          inputMode: "decimal",
                          sx: {
                            fontFamily: "var(--font-mono)",
                            fontVariantNumeric: "tabular-nums",
                            fontSize: 13,
                            textAlign: "right",
                          },
                        }}
                        sx={{ width: 96, flexShrink: 0 }}
                        data-testid={`simulation-signal-${sig.id}-field`}
                      />
                    </Stack>
                  </Box>
                ))}
              </Stack>
            </RaisedPanel>
          </Box>
        ) : (
          <Box sx={{ height: "100%" }}>
            <EmptyState
              text={EMPTY_PAGE_TEXT[activePage]}
              testId={`simulation-${activePage}-empty`}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
