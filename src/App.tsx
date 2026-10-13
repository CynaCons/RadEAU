import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { useState } from "react";
import { muiTheme } from "./theme/muiTheme";
import { AppTopBar } from "./shell/AppTopBar";
import { NavRail } from "./shell/NavRail";
import { ViewHost } from "./shell/ViewHost";
import { AboutDialog } from "./shell/AboutDialog";
import { DEFAULT_VIEW_ID } from "./shell/viewRegistry";
import { PerfZone } from "./runtime/perfProbe";

export function App() {
  const [railExpanded, setRailExpanded] = useState(false);
  const [activeViewId, setActiveViewId] = useState(DEFAULT_VIEW_ID);
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <PerfZone id="topbar">
          <AppTopBar onToggleRail={() => setRailExpanded((v) => !v)} />
        </PerfZone>
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <PerfZone id="navrail">
            <NavRail
              expanded={railExpanded}
              activeViewId={activeViewId}
              onNavigate={setActiveViewId}
              onAbout={() => setAboutOpen(true)}
            />
          </PerfZone>
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* Replay time bar mounts here when a replay source is configured (SRS_visual_ui.md §5.9). */}
            <ViewHost activeViewId={activeViewId} />
          </Box>
        </Box>
      </Box>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </ThemeProvider>
  );
}
