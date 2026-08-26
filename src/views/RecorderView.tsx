import {
  Box,
  Button,
  ButtonGroup,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import { useState } from "react";
import { RaisedPanel } from "../components/RaisedPanel";
import { useViewLifecycle } from "../shell/viewLifecycle";

// Mock data — replaced by live recorder state when the core lands (PRD §6).
const RECENT_CAPTURES = [
  { base: "20260826-1402_fusion-baseline.jsonl", dir: "C:\\Users\\dev\\RadEAU\\captures" },
  { base: "20260825-1731_sd-reboot-fault.jsonl", dir: "C:\\Users\\dev\\RadEAU\\captures" },
  { base: "20260825-0918_ptp-convergence.jsonl", dir: "C:\\Users\\dev\\RadEAU\\captures" },
  { base: "20260824-1650_burst-stress.jsonl", dir: "C:\\Users\\dev\\RadEAU\\captures\\stress" },
  { base: "20260824-1101_camera-dropout.jsonl", dir: "C:\\Users\\dev\\RadEAU\\captures" },
];

export function RecorderView() {
  useViewLifecycle("recorder", {});
  const [armed, setArmed] = useState(false);
  const [capturing] = useState(false);
  const [replayMode, setReplayMode] = useState(false);
  const [recentAnchor, setRecentAnchor] = useState<HTMLElement | null>(null);

  return (
    <Stack spacing={4} sx={{ maxWidth: 800 }}>
      <RaisedPanel
        icon={<FiberManualRecordIcon sx={{ color: "var(--error)" }} />}
        title="Record"
        leftRule={capturing ? "var(--error)" : undefined}
        testId="recorder-record-panel"
      >
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Switch
              size="small"
              checked={armed}
              onChange={(e) => setArmed(e.target.checked)}
              inputProps={{ "aria-label": "Arm recording" }}
              data-testid="recorder-arm-switch"
            />
            <Typography sx={{ fontSize: 14 }}>Arm recording at session start</Typography>
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              disabled
              value="C:\Users\dev\RadEAU\captures"
              inputProps={{ "aria-label": "Recording directory" }}
              data-testid="recorder-directory-field"
            />
            <Button
              variant="outlined"
              size="small"
              startIcon={<FolderOpenIcon />}
              data-testid="recorder-browse-btn"
            >
              Browse
            </Button>
          </Stack>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            Recordings are written to the captures directory as timestamped JSONL files.
          </Typography>
          {capturing ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                disabled
                value="C:\Users\dev\RadEAU\captures\20260826-1544_session.jsonl"
                inputProps={{ "aria-label": "Active capture file", sx: { fontFamily: "var(--font-mono)", fontSize: 13 } }}
                data-testid="recorder-active-file-field"
              />
              <Tooltip title="Copy path">
                <IconButton size="small" aria-label="Copy path" data-testid="recorder-copy-path-btn">
                  <ContentCopyIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            </Stack>
          ) : null}
        </Stack>
      </RaisedPanel>

      <RaisedPanel
        icon={<PlayCircleOutlineIcon sx={{ color: "var(--info)" }} />}
        title="Replay"
        testId="recorder-replay-panel"
      >
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Switch
              size="small"
              checked={replayMode}
              onChange={(e) => setReplayMode(e.target.checked)}
              inputProps={{ "aria-label": "Replay mode" }}
              data-testid="recorder-replay-switch"
            />
            <Typography sx={{ fontSize: 14 }}>Replay mode</Typography>
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              disabled
              placeholder="No replay source configured"
              inputProps={{ "aria-label": "Replay source" }}
              data-testid="recorder-source-field"
            />
            <ButtonGroup variant="outlined" size="small">
              <Button startIcon={<FolderOpenIcon />} data-testid="recorder-replay-browse-btn">
                Browse
              </Button>
              <Button
                size="small"
                aria-label="Recent captures"
                onClick={(e) => setRecentAnchor(e.currentTarget)}
                data-testid="recorder-recent-btn"
              >
                <ArrowDropDownIcon />
              </Button>
            </ButtonGroup>
            <Menu
              anchorEl={recentAnchor}
              open={recentAnchor !== null}
              onClose={() => setRecentAnchor(null)}
            >
              {RECENT_CAPTURES.map((c) => (
                <MenuItem
                  key={c.base}
                  onClick={() => setRecentAnchor(null)}
                  data-testid={`recorder-recent-${c.base}`}
                >
                  <Box>
                    <Typography sx={{ fontSize: 14 }}>{c.base}</Typography>
                    <Typography
                      sx={{
                        fontSize: 12,
                        color: "text.secondary",
                        maxWidth: 360,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.dir}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Menu>
          </Stack>
        </Stack>
      </RaisedPanel>
    </Stack>
  );
}
