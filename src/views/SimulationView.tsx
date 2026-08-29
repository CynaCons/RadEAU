import {
  Box,
  ButtonBase,
  Divider,
  IconButton,
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
import { SIM_EMPTY, type SimPageId } from "../runtime/simulationDisplay";
import { useViewLifecycle } from "../shell/viewLifecycle";

// Secondary rail geometry mirrors the primary rail (SRS_visual_ui.md §5.4/§4.4).
const RAIL_COLLAPSED = 65;
const RAIL_EXPANDED = 240;
const RAIL_TRANSITION = "width 225ms cubic-bezier(0.4, 0, 0.6, 1)";
const LABEL_TRANSITION = "opacity 225ms cubic-bezier(0.4, 0, 0.6, 1)";

interface SimPage {
  id: SimPageId;
  label: string;
  icon: SvgIconComponent;
}

const SIM_PAGES: SimPage[] = [
  { id: "node", label: "Node simulation", icon: DnsIcon },
  { id: "signal", label: "Signal simulation", icon: TuneIcon },
  { id: "frame-gen", label: "Frame generation", icon: DynamicFeedIcon },
  { id: "presets", label: "Presets", icon: BookmarksIcon },
];

export function SimulationView() {
  useViewLifecycle("simulation", {});
  const [railExpanded, setRailExpanded] = useState(true);
  const [activePage, setActivePage] = useState<SimPageId>("signal");

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
        <Box sx={{ height: "100%" }}>
          <EmptyState
            text={SIM_EMPTY[activePage]}
            testId={`simulation-${activePage}-empty`}
          />
        </Box>
      </Box>
    </Box>
  );
}
