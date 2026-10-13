/**
 * Recorder view (SRS_visual_ui.md §5.3): continuous pcap Record panel
 * (CP-014..016) plus Export buffered frames and Replay Browse.
 */

import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import { pickDirectory, pickPcapFile } from "../runtime/desktop";
import {
  RECORDER_DIR_CAPTION,
  RECORDER_EMPTY,
  RECORDER_REPLAY_CAPTION,
  formatActiveRecordingStats,
  recorderExportLabel,
  recordingListModel,
  recordingPanelActive,
} from "../runtime/recorderDisplay";
import { recordingStore } from "../runtime/recordingStore";
import { runExportRing } from "../runtime/ringExport";
import { sessionStore } from "../runtime/sessionStore";
import { traceStore } from "../runtime/traceStore";
import { shallowEqual } from "../runtime/useStoreSelector";
import { useActiveStoreSelector } from "../components/useActiveStoreSelector";
import { useViewActive, useViewLifecycle } from "../shell/viewLifecycle";

const MONO = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
} as const;

function ActiveRecordingStats(props: { active: boolean }) {
  const stats = useActiveStoreSelector(
    props.active,
    recordingStore,
    ({ frames, bytes, dropped }) => ({ frames, bytes, dropped }),
    { frames: 0, bytes: 0, dropped: 0 },
    shallowEqual,
  );
  return (
    <Typography sx={{ ...MONO, fontSize: 12, color: "text.secondary" }} data-testid="recorder-active-stats">
      {formatActiveRecordingStats(stats)}
    </Typography>
  );
}

function ExportBufferedFrames(props: { active: boolean }) {
  const frameCount = useActiveStoreSelector(props.active, traceStore, (snap) => snap.rows.length, 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const tooltip = frameCount === 0 ? "no frames buffered" : "Export buffered frames as pcap";

  const onExport = async () => {
    if (busy || frameCount === 0) return;
    setBusy(true);
    setMessage(null);
    const outcome = await runExportRing();
    setBusy(false);
    if (outcome.message === "export cancelled") return;
    setError(!outcome.ok);
    setMessage(outcome.message);
  };

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Tooltip title={tooltip}>
        <span>
          <Button variant="outlined" size="small" startIcon={<DownloadIcon />} disabled={frameCount === 0 || busy}
            onClick={() => { void onExport(); }} data-testid="recorder-export-btn">
            {recorderExportLabel(frameCount)}
          </Button>
        </span>
      </Tooltip>
      {message ? (
        <Typography sx={{ fontSize: 12, color: error ? "var(--error)" : "text.secondary" }} data-testid="recorder-export-result">
          {message}
        </Typography>
      ) : null}
    </Stack>
  );
}

export function RecorderView() {
  useViewLifecycle("recorder", {});
  const active = useViewActive("recorder");
  const session = useActiveStoreSelector(active, sessionStore, ({ running, sourceKind, pcapPath }) => ({ running, sourceKind, pcapPath }), sessionStore.getSnapshot(), shallowEqual);
  const recording = useActiveStoreSelector(
    active,
    recordingStore,
    ({ armed, active, path, error, dir, list, dirError }) => ({ armed, active, path, error, dir, list, dirError }),
    recordingStore.getSnapshot(),
    shallowEqual,
  );
  const [dirDraft, setDirDraft] = useState(recording.dir);

  // Keep the editable field in sync when the store loads / Browse commits.
  useEffect(() => {
    setDirDraft(recording.dir);
  }, [recording.dir]);

  const recordDisabled = session.sourceKind === "pcap";
  const dirLocked = recording.active;
  const panelActive = recordingPanelActive(recording);
  const listRows = recordingListModel(recording.list);

  /** Commit from the input value (not React state) so blur-after-type works. */
  const commitDirValue = async (value: string) => {
    if (dirLocked) return;
    const trimmed = value.trim();
    if (trimmed === recording.dir) return;
    setDirDraft(trimmed);
    await recordingStore.setDir(trimmed);
  };

  const onBrowseDir = async () => {
    if (dirLocked) return;
    try {
      const path = await pickDirectory();
      if (!path) return;
      setDirDraft(path);
      await recordingStore.setDir(path);
    } catch {
      // Dialog unavailable — the editable path field stays usable.
    }
  };

  const onReplayBrowse = async () => {
    if (session.running) return;
    const path = await pickPcapFile();
    if (!path) return;
    sessionStore.setPcapSource(path);
  };

  const onReplayItem = (path: string) => {
    if (session.running) return;
    sessionStore.setPcapSource(path);
  };

  const onCopyPath = () => {
    if (!recording.path) return;
    void navigator.clipboard
      ?.writeText(recording.path)
      .catch((err: unknown) => console.warn("Failed to copy recording path", err));
  };

  const armTooltip = recordDisabled
    ? "Recording is disabled while a pcap file is the capture source"
    : "Arm continuous pcap recording (starts with the next session)";

  return (
    <Stack spacing={4} sx={{ maxWidth: 800 }}>
      <RaisedPanel
        icon={<FiberManualRecordIcon sx={{ color: "var(--error)" }} />}
        title="Record"
        leftRule={panelActive ? "var(--error)" : undefined}
        testId="recorder-record-panel"
      >
        <Stack spacing={2}>
          <Tooltip title={armTooltip}>
            <Box>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  size="small"
                  checked={recording.armed}
                  disabled={recordDisabled}
                  onChange={(_, checked) => {
                    void recordingStore.arm(checked);
                  }}
                  inputProps={{ "aria-label": "Arm recording" }}
                  data-testid="recorder-arm-switch"
                  sx={{
                    "& .MuiSwitch-switchBase.Mui-checked": { color: "var(--error)" },
                    "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": {
                      backgroundColor: "var(--error)",
                    },
                  }}
                />
                <Typography sx={{ fontSize: 14 }}>Arm recording at session start</Typography>
              </Stack>
            </Box>
          </Tooltip>

          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              size="small"
              fullWidth
              disabled={dirLocked}
              value={dirDraft}
              onChange={(e) => setDirDraft(e.target.value)}
              onBlur={(e) => {
                void commitDirValue(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitDirValue((e.target as HTMLInputElement).value);
                }
              }}
              error={Boolean(recording.dirError)}
              helperText={recording.dirError ?? undefined}
              placeholder="Recordings directory"
              inputProps={{ "aria-label": "Recording directory" }}
              data-testid="recorder-dir"
            />
            <Tooltip
              title={
                dirLocked
                  ? "Directory cannot change while a recording is active"
                  : "Choose recordings directory"
              }
            >
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<FolderOpenIcon />}
                  disabled={dirLocked}
                  onClick={() => {
                    void onBrowseDir();
                  }}
                  data-testid="recorder-dir-browse"
                >
                  Browse
                </Button>
              </span>
            </Tooltip>
          </Stack>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            {RECORDER_DIR_CAPTION}
          </Typography>

          {recording.active ? (
            <Stack spacing={1} data-testid="recorder-active">
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  fullWidth
                  disabled
                  value={recording.path ?? ""}
                  inputProps={{
                    "aria-label": "Active recording path",
                    sx: MONO,
                  }}
                  data-testid="recorder-active-path"
                />
                <Tooltip title="Copy path">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="Copy active recording path"
                      disabled={!recording.path}
                      onClick={onCopyPath}
                      data-testid="recorder-active-copy"
                    >
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              <ActiveRecordingStats active={active} />
            </Stack>
          ) : null}

          {recording.error ? (
            <Alert severity="error" data-testid="recorder-error">
              {recording.error}
            </Alert>
          ) : null}

          {listRows.length === 0 ? (
            <Box sx={{ position: "relative", minHeight: 36 }}>
              <EmptyState text={RECORDER_EMPTY} inset testId="recorder-empty" />
            </Box>
          ) : (
            <Stack spacing={1} data-testid="recorder-list">
              {listRows.map((row, index) => (
                <Stack
                  key={row.path}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  data-testid={`recorder-item-${index}`}
                  sx={{
                    py: 0.5,
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 14, fontWeight: 500 }} noWrap>
                      {row.basename}
                    </Typography>
                    <Typography
                      sx={{
                        ...MONO,
                        fontSize: 12,
                        color: "text.secondary",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={row.path}
                    >
                      {row.path}
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                      {row.bytesLabel}
                      {row.framesLabel ? ` · ${row.framesLabel}` : ""}
                    </Typography>
                  </Box>
                  <Tooltip
                    title={
                      session.running
                        ? "Interface cannot change while a session is running"
                        : "Replay this recording as the capture source"
                    }
                  >
                    <span>
                      <Button
                        variant="outlined"
                        size="small"
                        disabled={session.running}
                        onClick={() => onReplayItem(row.path)}
                        data-testid={`recorder-item-replay-${index}`}
                      >
                        Replay
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              ))}
            </Stack>
          )}

          <ExportBufferedFrames active={active} />
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
