import {
  Box,
  Button,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from "@mui/material";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import { useState } from "react";
import { replayStore } from "../runtime/replayStore";
import { sessionStore } from "../runtime/sessionStore";
import { shallowEqual, useStoreSelector } from "../runtime/useStoreSelector";
import type { ReplaySpeed } from "../runtime/desktop";

const SPEEDS: readonly ReplaySpeed[] = [0.1, 0.25, 0.5, 1, 2, 5, 10, null];

const BAR_SX = {
  minHeight: 40,
  px: 1.5,
  py: 1,
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  gap: 1.5,
} as const;
const LABEL_SX = { width: 140, fontSize: 12, color: "text.secondary", fontFamily: "var(--font-mono)" } as const;
const SLIDER_SX = { flex: 1, minWidth: 120 } as const;
const SPEED_SX = { minWidth: 86, height: 32, fontSize: 13 } as const;
const PLAY_PAUSED_SX = {
  bgcolor: "var(--warning)",
  color: "var(--surface-canvas)",
  "&:hover": { bgcolor: "var(--warning-dark)" },
} as const;

function formatSeconds(ns: number): string {
  return `${(ns / 1_000_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  })}s`;
}

function speedValue(speed: ReplaySpeed | undefined): string {
  return speed === null || speed === undefined ? "max" : String(speed);
}

function parseSpeed(value: string): ReplaySpeed {
  if (value === "max") return null;
  return Number(value) as ReplaySpeed;
}

export function replaySliderValue(value: number | number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : value;
}

export function commitReplaySliderSeek(
  value: number | number[],
  seek: (tNs: number) => Promise<void> | void,
): void {
  void seek(replaySliderValue(value));
}

export function ReplayTimeBar() {
  const session = useStoreSelector(
    sessionStore,
    ({ sourceKind, running }) => ({ sourceKind, running }),
    shallowEqual,
  );
  const visible = session.sourceKind === "pcap";
  const running = session.running;
  const replay = useStoreSelector(
    replayStore,
    ({ info, position }) => ({ info, position }),
    shallowEqual,
    visible,
  );
  const position = replay.position;
  const durationNs = position?.durationNs ?? replay.info?.durationNs ?? 0;
  const currentNs = position?.tNs ?? 0;
  const [dragNs, setDragNs] = useState<number | null>(null);
  const shownNs = dragNs ?? currentNs;
  const state = position?.state ?? "paused";
  const paused = state !== "playing";
  // Step and seek act on a running replay session; Play starts one.
  const canStep = running && state === "paused";
  const speed = (position?.speed ?? 1) as ReplaySpeed;

  if (!visible) return null;

  const label =
    state === "ended"
      ? `ended / ${formatSeconds(durationNs)}`
      : `${formatSeconds(shownNs)} / ${formatSeconds(durationNs)}`;

  const onPlayPause = async () => {
    if (state === "playing") {
      await replayStore.pause();
      return;
    }
    // VU-028: at end, play restarts from the beginning.
    if (state === "ended") await replayStore.seek(0);
    await replayStore.play();
  };

  const commitSeek = (value: number | number[]) => {
    setDragNs(null);
    commitReplaySliderSeek(value, (target) => replayStore.seek(target));
  };

  return (
    <Box
      data-testid="replay-bar"
      sx={BAR_SX}
    >
      <Typography
        data-testid="replay-position"
        sx={LABEL_SX}
      >
        {label}
      </Typography>

      <Tooltip title="analysis arrives with trace analysis">
        <span>
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ pr: 2, mr: 0.5, borderRight: "1px solid var(--border)" }}
          >
            <Switch size="small" disabled inputProps={{ "aria-label": "Fast analysis" }} />
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              Fast analysis
            </Typography>
          </Stack>
        </span>
      </Tooltip>

      <Slider
        data-testid="replay-slider"
        min={0}
        max={Math.max(durationNs, 1)}
        step={1_000_000}
        value={Math.min(shownNs, Math.max(durationNs, 1))}
        disabled={!running || durationNs <= 0}
        onChange={(_, value) => {
          setDragNs(replaySliderValue(value));
        }}
        onChangeCommitted={(_, value) => {
          commitSeek(value);
        }}
        aria-label="Replay seek"
        title={formatSeconds(shownNs)}
        sx={SLIDER_SX}
      />

      <Select
        size="small"
        value={speedValue(speed)}
        onChange={(event) => {
          void replayStore.setSpeed(parseSpeed(event.target.value));
        }}
        inputProps={{ "aria-label": "Replay speed", "data-testid": "replay-speed" }}
        sx={SPEED_SX}
      >
        {SPEEDS.map((item) => (
          <MenuItem key={speedValue(item)} value={speedValue(item)}>
            {item === null ? "max" : `${item}×`}
          </MenuItem>
        ))}
      </Select>

      <Tooltip title={canStep ? "" : running ? "pause replay to step one frame" : "start the replay to step"}>
        <span>
          <Button
            data-testid="replay-step-btn"
            size="small"
            variant="outlined"
            startIcon={<SkipNextIcon />}
            disabled={!canStep}
            onClick={() => {
              void replayStore.step();
            }}
          >
            Step
          </Button>
        </span>
      </Tooltip>

      <Button
        data-testid="replay-play-btn"
        size="small"
        variant="contained"
        startIcon={state === "playing" ? <PauseIcon /> : <PlayArrowIcon />}
        onClick={() => {
          void onPlayPause();
        }}
        sx={paused ? PLAY_PAUSED_SX : undefined}
      >
        {state === "playing" ? "Pause" : "Play"}
      </Button>
    </Box>
  );
}
