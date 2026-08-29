/**
 * Recorder view (SRS_visual_ui.md §5.3): honest empty state until recording
 * lands in v0.6; Export buffered frames (same action as the Trace rail);
 * Replay Browse opens a pcap into the Interface source.
 */

import {
  Box,
  Button,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import { useState, useSyncExternalStore } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import { pickPcapFile } from "../runtime/desktop";
import {
  RECORDER_EMPTY,
  RECORDER_RECORDING_CAPTION,
  RECORDER_REPLAY_CAPTION,
  recorderExportLabel,
} from "../runtime/recorderDisplay";
import { runExportRing } from "../runtime/ringExport";
import { sessionStore } from "../runtime/sessionStore";
import { traceStore } from "../runtime/traceStore";
import { useViewLifecycle } from "../shell/viewLifecycle";

export function RecorderView() {
  useViewLifecycle("recorder", {});
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const snap = useSyncExternalStore(traceStore.subscribe, traceStore.getSnapshot);
  const frameCount = snap.rows.length;
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState(false);

  const onExport = async () => {
    if (exportBusy || frameCount === 0) return;
    setExportBusy(true);
    setExportMessage(null);
    const outcome = await runExportRing();
    setExportBusy(false);
    if (outcome.message === "export cancelled") return;
    setExportError(!outcome.ok);
    setExportMessage(outcome.message);
  };

  const onReplayBrowse = async () => {
    if (session.running) return;
    const path = await pickPcapFile();
    if (!path) return;
    sessionStore.setPcapSource(path);
  };

  const exportTooltip =
    frameCount === 0 ? "no frames buffered" : "Export buffered frames as pcap";

  return (
    <Stack spacing={4} sx={{ maxWidth: 800 }}>
      <RaisedPanel
        icon={<FiberManualRecordIcon sx={{ color: "var(--error)" }} />}
        title="Record"
        testId="recorder-record-panel"
      >
        <Stack spacing={2}>
          <Tooltip title={RECORDER_RECORDING_CAPTION}>
            <Box>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  size="small"
                  checked={false}
                  disabled
                  inputProps={{ "aria-label": "Arm recording" }}
                  data-testid="recorder-arm-switch"
                />
                <Typography sx={{ fontSize: 14 }}>Arm recording at session start</Typography>
              </Stack>
            </Box>
          </Tooltip>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              disabled
              value=""
              placeholder="—"
              inputProps={{ "aria-label": "Recording directory" }}
              data-testid="recorder-directory-field"
            />
            <Tooltip title={RECORDER_RECORDING_CAPTION}>
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<FolderOpenIcon />}
                  disabled
                  data-testid="recorder-browse-btn"
                >
                  Browse
                </Button>
              </span>
            </Tooltip>
          </Stack>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {RECORDER_RECORDING_CAPTION}
          </Typography>

          <Box sx={{ position: "relative", minHeight: 36 }}>
            <EmptyState text={RECORDER_EMPTY} inset testId="recorder-empty" />
          </Box>

          <Stack direction="row" spacing={1} alignItems="center">
            <Tooltip title={exportTooltip}>
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<DownloadIcon />}
                  disabled={frameCount === 0 || exportBusy}
                  onClick={() => {
                    void onExport();
                  }}
                  data-testid="recorder-export-btn"
                >
                  {recorderExportLabel(frameCount)}
                </Button>
              </span>
            </Tooltip>
            {exportMessage ? (
              <Typography
                sx={{
                  fontSize: 12,
                  color: exportError ? "var(--error)" : "text.secondary",
                }}
                data-testid="recorder-export-result"
              >
                {exportMessage}
              </Typography>
            ) : null}
          </Stack>
        </Stack>
      </RaisedPanel>

      <RaisedPanel
        icon={<PlayCircleOutlineIcon sx={{ color: "var(--info)" }} />}
        title="Replay"
        testId="recorder-replay-panel"
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              disabled
              value={session.sourceKind === "pcap" ? session.pcapPath : ""}
              placeholder="No replay source configured"
              inputProps={{
                "aria-label": "Replay source",
                sx: { fontFamily: "var(--font-mono)", fontSize: 13 },
              }}
              data-testid="recorder-source-field"
            />
            <Tooltip
              title={
                session.running
                  ? "Interface cannot change while a session is running"
                  : "Open a pcap / pcapng as the capture source"
              }
            >
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<FolderOpenIcon />}
                  disabled={session.running}
                  onClick={() => {
                    void onReplayBrowse();
                  }}
                  data-testid="recorder-replay-browse"
                >
                  Browse
                </Button>
              </span>
            </Tooltip>
          </Stack>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {RECORDER_REPLAY_CAPTION}
          </Typography>
        </Stack>
      </RaisedPanel>
    </Stack>
  );
}
