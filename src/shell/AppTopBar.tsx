import { Box, Button, IconButton, Switch, TextField, Tooltip, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import SaveIcon from "@mui/icons-material/Save";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import RemoveIcon from "@mui/icons-material/Remove";
import CropSquareIcon from "@mui/icons-material/CropSquare";
import FilterNoneIcon from "@mui/icons-material/FilterNone";
import CloseIcon from "@mui/icons-material/Close";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  closeWindow,
  minimizeWindow,
  onMaximizedChange,
  toggleMaximizeWindow,
} from "../runtime/desktop";
import { sessionStore } from "../runtime/sessionStore";
import radeauMark from "../assets/radeau-mark.png";

/** Interactive app-bar children opt out of the window drag region (VU-008). */
const noDrag = {
  onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
};

/**
 * App bar (SRS_visual_ui.md §4.3): 48 px, surface-raised, 1 px bottom border,
 * a window drag region with the specified nine-control inventory. The run
 * control owns the capture session via sessionStore.
 */
export function AppTopBar(props: { onToggleRail: () => void }) {
  const [autosave, setAutosave] = useState(true);
  const [sessionTitle, setSessionTitle] = useState("");
  const [recordArmed, setRecordArmed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const running = session.running;

  useEffect(() => onMaximizedChange(setMaximized), []);

  const recording = running && recordArmed;
  const indicatorColor = recording
    ? "var(--error)"
    : recordArmed
      ? "var(--warning)"
      : "var(--text-secondary)";

  const windowButtonSx = {
    width: 24,
    height: 24,
    p: "4px",
    borderRadius: "4px",
    color: "text.secondary",
  } as const;

  return (
    <Box
      data-tauri-drag-region
      data-testid="app-bar"
      sx={{
        height: 48,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        bgcolor: "background.paper",
        borderBottom: "1px solid var(--border)",
        px: 1,
      }}
    >
      <Tooltip title="Toggle navigation rail">
        <IconButton
          {...noDrag}
          size="small"
          aria-label="Toggle navigation rail"
          onClick={props.onToggleRail}
          data-testid="appbar-rail-toggle"
          sx={{ mr: "16px" }}
        >
          <MenuIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Box
        component="img"
        src={radeauMark}
        alt=""
        aria-hidden
        sx={{ height: 40, width: 40, mr: "12px", pointerEvents: "none" }}
      />

      <Typography noWrap sx={{ fontSize: 20, fontWeight: 500, mr: "16px" }}>
        RadEAU
      </Typography>

      <Tooltip title={autosave ? "Disable session autosave" : "Enable session autosave"}>
        <IconButton
          {...noDrag}
          size="small"
          aria-label={autosave ? "Disable session autosave" : "Enable session autosave"}
          aria-pressed={autosave}
          onClick={() => setAutosave((v) => !v)}
          data-testid="appbar-autosave-toggle"
          sx={{ color: autosave ? "var(--accent-primary)" : "var(--text-secondary)" }}
        >
          <SaveIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Box sx={{ flex: 1, display: "flex", justifyContent: "center" }}>
        <TextField
          {...noDrag}
          size="small"
          placeholder="Session title"
          value={sessionTitle}
          onChange={(e) => setSessionTitle(e.target.value)}
          inputProps={{ "aria-label": "Session title", "data-testid": "appbar-session-title" }}
          sx={{
            width: 300,
            "& input::placeholder": { opacity: 0.6 },
          }}
        />
      </Box>

      <Tooltip title={recording ? "Recording" : recordArmed ? "Recording armed" : "Recording idle"}>
        <RadioButtonCheckedIcon
          data-testid="appbar-record-indicator"
          sx={{ fontSize: 16, color: indicatorColor, mx: 1 }}
        />
      </Tooltip>

      <Tooltip title={recordArmed ? "Disarm recording" : "Arm recording"}>
        <Switch
          {...noDrag}
          size="small"
          checked={recordArmed}
          onChange={(e) => setRecordArmed(e.target.checked)}
          disabled={false}
          data-testid="appbar-record-switch"
          inputProps={{ "aria-label": "Arm recording" }}
          sx={{
            mr: 1,
            "& .MuiSwitch-switchBase.Mui-checked": { color: "var(--error)" },
            "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": {
              backgroundColor: "var(--error)",
            },
          }}
        />
      </Tooltip>

      <Button
        {...noDrag}
        variant="contained"
        size="small"
        color={running ? "error" : "success"}
        startIcon={running ? <StopIcon /> : <PlayArrowIcon />}
        onClick={() => {
          void sessionStore.toggle();
        }}
        data-testid="appbar-run-btn"
        sx={{ mr: 2, minWidth: 88 }}
      >
        {running ? "Stop" : "Start"}
      </Button>

      <Box sx={{ display: "flex", gap: "4px" }}>
        <Tooltip title="Minimize">
          <IconButton
            {...noDrag}
            aria-label="Minimize window"
            onClick={minimizeWindow}
            data-testid="appbar-minimize-btn"
            sx={windowButtonSx}
          >
            <RemoveIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={maximized ? "Restore" : "Maximize"}>
          <IconButton
            {...noDrag}
            aria-label={maximized ? "Restore window" : "Maximize window"}
            onClick={toggleMaximizeWindow}
            data-testid="appbar-maximize-btn"
            sx={windowButtonSx}
          >
            {maximized ? <FilterNoneIcon sx={{ fontSize: 14 }} /> : <CropSquareIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Close">
          <IconButton
            {...noDrag}
            aria-label="Close window"
            onClick={closeWindow}
            data-testid="appbar-close-btn"
            sx={{
              ...windowButtonSx,
              "&:hover": { bgcolor: "var(--error)", color: "var(--text-primary)" },
            }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
