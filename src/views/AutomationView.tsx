import { Box, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { useViewLifecycle } from "../shell/viewLifecycle";

// Mock data — replaced by the automation runtime when the core lands (PRD §6).
// Deterministic; plausible for a SOME/IP sensor-fusion network under test.
interface ScriptEntry {
  file: string;
  dir: string;
}

const SCRIPTS: ScriptEntry[] = [
  { file: "sd_monitor_soak.py", dir: "C:\\Users\\dev\\RadEAU\\scripts" },
  { file: "fusion_latency_report.py", dir: "C:\\Users\\dev\\RadEAU\\scripts" },
  { file: "camera_dropout_probe.py", dir: "C:\\Users\\dev\\RadEAU\\scripts\\diagnostics" },
  { file: "replay_regression.py", dir: "C:\\Users\\dev\\RadEAU\\scripts\\ci" },
  { file: "ptp_offset_export.py", dir: "C:\\Users\\dev\\RadEAU\\scripts" },
];

const INITIAL_RUNNING = "sd_monitor_soak.py";

interface ConsoleLine {
  t: number;
  text: string;
  stderr?: boolean;
}

const CONSOLE_LINES: ConsoleLine[] = [
  { t: 0.0, text: "sd_monitor_soak.py — RadEAU automation API 0.1.0 @ 127.0.0.1:8899" },
  { t: 0.0182, text: "session open: fusion-baseline (live, channel eth0)" },
  { t: 0.041, text: "subscribe CameraObjects 0x1101/0x8001 @ 10.42.0.11" },
  { t: 0.0463, text: "subscribe RadarTargets 0x1102/0x8001 @ 10.42.0.12" },
  { t: 0.0518, text: "subscribe LidarClusters 0x1103/0x8001 @ 10.42.0.13" },
  { t: 0.0574, text: "subscribe VehicleDynamics 0x1104/0x8002 @ 10.42.0.14" },
  { t: 0.0631, text: "subscribe FusedObjects 0x1201/0x8001 @ 10.42.0.20" },
  { t: 1.0007, text: "cycle 1: 5 services up, 0 TTL expiries, mean latency 1.84 ms" },
  { t: 2.0011, text: "cycle 2: 5 services up, 0 TTL expiries, mean latency 1.79 ms" },
  {
    t: 2.4186,
    text: "WARN RadarTargets 0x1102: cycle jitter 4.71 ms exceeds 4.00 ms budget",
    stderr: true,
  },
  { t: 3.0007, text: "cycle 3: 5 services up, 0 TTL expiries, mean latency 1.81 ms" },
  {
    t: 3.5921,
    text: "WARN FusedObjects 0x1201: subscribe NACK from 10.42.0.20, retrying (1/3)",
    stderr: true,
  },
  { t: 3.8443, text: "resubscribe FusedObjects 0x1201/0x8001 @ 10.42.0.20 ok" },
  { t: 4.0013, text: "cycle 4: 5 services up, 0 TTL expiries, mean latency 1.86 ms" },
  { t: 5.0009, text: "cycle 5: 5 services up, 0 TTL expiries, mean latency 1.80 ms" },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function AutomationView() {
  useViewLifecycle("automation", {});
  const [scripts, setScripts] = useState<ScriptEntry[]>(SCRIPTS);
  const [runningFile, setRunningFile] = useState<string | null>(INITIAL_RUNNING);
  const [lines, setLines] = useState<ConsoleLine[]>(CONSOLE_LINES);
  const consoleBodyRef = useRef<HTMLDivElement | null>(null);

  // The console follows the tail (SRS_visual_ui.md §5.5).
  useEffect(() => {
    const el = consoleBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        gap: "16px",
        p: "16px",
        boxSizing: "border-box",
      }}
    >
      {/* Script list — fixed 300 px */}
      <Box
        data-testid="automation-script-list"
        sx={{
          width: 300,
          flexShrink: 0,
          bgcolor: "background.paper",
          border: "1px solid var(--border)",
          borderRadius: 1,
          overflowY: "auto",
        }}
      >
        {scripts.length === 0 ? (
          <EmptyState
            text="No scripts — add files to the scripts directory"
            testId="automation-script-list-empty"
          />
        ) : (
          scripts.map((s) => {
            const running = s.file === runningFile;
            const id = slug(s.file);
            return (
              <Stack
                key={s.file}
                direction="row"
                alignItems="center"
                data-testid={`automation-script-row-${id}`}
                sx={{
                  px: "12px",
                  py: "6px",
                  gap: "4px",
                  "&:not(:last-of-type)": { borderBottom: "1px solid var(--border)" },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    noWrap
                    sx={{
                      fontSize: 14,
                      ...(running
                        ? { color: "var(--accent-primary)", fontWeight: 700 }
                        : { color: "text.primary" }),
                    }}
                  >
                    {s.file}
                  </Typography>
                  <Typography noWrap sx={{ fontSize: 12, color: "text.secondary" }}>
                    {s.dir}
                  </Typography>
                </Box>
                <Tooltip title={running ? "Stop" : "Run"}>
                  <IconButton
                    size="small"
                    aria-label={running ? "Stop" : "Run"}
                    onClick={() => setRunningFile(running ? null : s.file)}
                    data-testid={`automation-${running ? "stop" : "run"}-btn-${id}`}
                  >
                    {running ? (
                      <StopIcon fontSize="inherit" sx={{ color: "var(--error)" }} />
                    ) : (
                      <PlayArrowIcon fontSize="inherit" sx={{ color: "var(--success)" }} />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton
                    size="small"
                    aria-label="Delete"
                    onClick={() => {
                      setScripts((prev) => prev.filter((p) => p.file !== s.file));
                      if (running) setRunningFile(null);
                    }}
                    data-testid={`automation-delete-btn-${id}`}
                  >
                    <DeleteOutlineIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Stack>
            );
          })
        )}
      </Box>

      {/* Console — flexible */}
      <Box
        data-testid="automation-console"
        sx={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 1,
          overflow: "hidden",
        }}
      >
        <Stack
          direction="row"
          alignItems="center"
          sx={{
            bgcolor: "background.paper",
            borderBottom: "1px solid var(--border)",
            px: "12px",
            minHeight: 40,
            gap: "8px",
          }}
        >
          <Typography
            noWrap
            sx={{
              flex: 1,
              minWidth: 0,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "text.secondary",
            }}
          >
            {runningFile ?? "console"}
          </Typography>
          <Tooltip title="Clear console">
            <IconButton
              size="small"
              aria-label="Clear console"
              onClick={() => setLines([])}
              data-testid="automation-console-clear-btn"
            >
              <DeleteSweepIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Box
          ref={consoleBodyRef}
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            bgcolor: "var(--surface-canvas)",
            p: "16px",
            lineHeight: 1.5,
          }}
        >
          {lines.length === 0 ? (
            <EmptyState
              text="Console cleared — run a script to see its output"
              testId="automation-console-empty"
            />
          ) : (
            lines.map((line, i) => (
              <Box key={i} sx={{ display: "flex", alignItems: "baseline" }}>
                <Box
                  component="span"
                  sx={{
                    userSelect: "none",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    color: "var(--text-tertiary)",
                    fontVariantNumeric: "tabular-nums",
                    mr: "16px",
                    minWidth: 56,
                    textAlign: "right",
                    flexShrink: 0,
                  }}
                >
                  {line.t.toFixed(4)}
                </Box>
                <Box
                  component="span"
                  sx={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 14,
                    fontVariantNumeric: "tabular-nums",
                    color: line.stderr ? "var(--error)" : "text.primary",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {line.text}
                </Box>
              </Box>
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}
