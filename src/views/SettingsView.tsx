import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import BugReportIcon from "@mui/icons-material/BugReport";
import CodeIcon from "@mui/icons-material/Code";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import MemoryIcon from "@mui/icons-material/Memory";
import SensorsIcon from "@mui/icons-material/Sensors";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import SpeedIcon from "@mui/icons-material/Speed";
import { useState } from "react";
import type { ReactNode } from "react";
import { RaisedPanel } from "../components/RaisedPanel";
import { useViewLifecycle } from "../shell/viewLifecycle";

// ── Mock data — replaced by live settings state when the core lands (PRD §6). ──

/** Deterministic mock: a session is running, so session-bound settings are
 *  disabled with a tooltip naming why (SRS_visual_ui.md §5.7). */
const SESSION_RUNNING = true;

const CHANNEL_OPTIONS = [
  { value: "simulator", label: "Simulator link — scenario: sensor-fusion" },
  { value: "loopback", label: "Loopback (in-process)" },
  { value: "stub", label: "Stub" },
];

const REFRESH_OPTIONS = [
  { value: 16, label: "16 ms (60 Hz)" },
  { value: 33, label: "33 ms (30 Hz)" },
  { value: 100, label: "100 ms (10 Hz)" },
];

const DIAG_REPORT = [
  "RadEAU diagnostic report",
  "generated   2026-08-26 14:52:07.4180",
  "build       0.1.3+dev.4021 (8c41f2ea)",
  "channel     Simulator link — scenario: sensor-fusion",
  "uptime      2477.2148 s    frames 1284502    drops 0",
  "",
  "service  0x1101 CameraObjects    10.42.0.11:30501  cycle  16.6671 ms",
  "service  0x1102 RadarTargets     10.42.0.12:30502  cycle  20.0004 ms",
  "service  0x1103 LidarClusters    10.42.0.13:30503  cycle 100.0018 ms",
  "service  0x1104 VehicleDynamics  10.42.0.14:30504  cycle  10.0001 ms",
  "service  0x1201 FusedObjects     10.42.0.20:30512  cycle  40.0009 ms",
  "",
  "sd       offers 5    subscriptions 7    ttl expiries 0",
  "gptp     offset +0.0002 ms    rate ratio 1.0000",
].join("\n");

const MEMORY_POOLS = [
  { id: "ring", label: "Ring buffers — 412 MB" },
  { id: "decode", label: "Decode cache — 96 MB" },
];

const MONO_SX = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
} as const;

/** A switch row plus its mandatory 12 px consequence caption indented 32 px. */
function SwitchRow(props: {
  label: string;
  caption: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  const { label, caption, checked, onChange, testId } = props;
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Switch
          size="small"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          inputProps={{ "aria-label": label }}
          data-testid={testId}
        />
        <Typography sx={{ fontSize: 14 }}>{label}</Typography>
      </Stack>
      <Typography sx={{ fontSize: 12, color: "text.secondary", pl: "32px" }}>{caption}</Typography>
    </Box>
  );
}

/** Wraps a disabled control so its reason-naming tooltip still fires (§7.3). */
function DisabledReason(props: { reason: string; disabled: boolean; children: ReactNode }) {
  const { reason, disabled, children } = props;
  if (!disabled) return <>{children}</>;
  return (
    <Tooltip title={reason}>
      <Box component="span" sx={{ display: "block" }}>
        {children}
      </Box>
    </Tooltip>
  );
}

export function SettingsView() {
  useViewLifecycle("settings", {});

  const [channel, setChannel] = useState("simulator");
  const [transmitOnly, setTransmitOnly] = useState(false);
  const [refreshMs, setRefreshMs] = useState(33);
  const [lowOverhead, setLowOverhead] = useState(false);
  const [port, setPort] = useState("5555");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [token, setToken] = useState("tok-5c9a1f2e-90aa-4c21");
  const [allowlist, setAllowlist] = useState("127.0.0.1, 10.42.0.99");
  const [collectStats, setCollectStats] = useState(true);
  const [logSd, setLogSd] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const copyReport = () => {
    void navigator.clipboard?.writeText(DIAG_REPORT);
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 800 }}>
      <RaisedPanel
        icon={<SettingsEthernetIcon sx={{ color: "var(--accent-primary)" }} />}
        title="Interface"
        subtitle="Selects the channel RadEAU attaches to and how frames may leave the tool."
        testId="settings-interface-panel"
      >
        <Stack spacing={2}>
          {SESSION_RUNNING ? (
            <Box>
              <Chip
                size="small"
                variant="outlined"
                color="success"
                icon={<SensorsIcon />}
                label="Session running — sensor-fusion"
                data-testid="settings-session-chip"
              />
            </Box>
          ) : null}
          <DisabledReason
            disabled={SESSION_RUNNING}
            reason="Channel cannot change while a session is running"
          >
            <TextField
              select
              size="small"
              fullWidth
              label="Channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              disabled={SESSION_RUNNING}
              data-testid="settings-channel-select"
            >
              {CHANNEL_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value} data-testid={`settings-channel-option-${o.value}`}>
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
          </DisabledReason>
          <SwitchRow
            label="Transmit-only mode"
            caption="Disables the receive path — the channel carries only frames generated by Simulation and Automation."
            checked={transmitOnly}
            onChange={setTransmitOnly}
            testId="settings-transmit-only-switch"
          />
        </Stack>
      </RaisedPanel>

      <RaisedPanel
        icon={<SpeedIcon sx={{ color: "var(--info)" }} />}
        title="Performance"
        subtitle="Trades UI refresh work against capture headroom on constrained hosts."
        testId="settings-performance-panel"
      >
        <Stack spacing={2}>
          <TextField
            select
            size="small"
            fullWidth
            label="Refresh rate"
            value={refreshMs}
            onChange={(e) => setRefreshMs(Number(e.target.value))}
            helperText="UI refresh interval for live tables and charts."
            data-testid="settings-refresh-select"
          >
            {REFRESH_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value} data-testid={`settings-refresh-option-${o.value}`}>
                {o.label}
              </MenuItem>
            ))}
          </TextField>
          <SwitchRow
            label="Low-overhead mode"
            caption="Hides the Network and Simulation views and reduces decode depth so capture overhead stays minimal."
            checked={lowOverhead}
            onChange={setLowOverhead}
            testId="settings-low-overhead-switch"
          />
        </Stack>
      </RaisedPanel>

      <RaisedPanel
        icon={<CodeIcon sx={{ color: "var(--accent-secondary)" }} />}
        title="Automation"
        subtitle="Configures the local server that external test scripts connect to."
        testId="settings-automation-panel"
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={2}>
            <DisabledReason
              disabled={SESSION_RUNNING}
              reason="Stop the session to change the automation server port"
            >
              <TextField
                size="small"
                label="Port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={SESSION_RUNNING}
                sx={{ width: 96 }}
                inputProps={{ sx: MONO_SX }}
                data-testid="settings-automation-port-field"
              />
            </DisabledReason>
            <DisabledReason
              disabled={SESSION_RUNNING}
              reason="Stop the session to change the automation server bind host"
            >
              <TextField
                size="small"
                label="Bind host"
                value={bindHost}
                onChange={(e) => setBindHost(e.target.value)}
                disabled={SESSION_RUNNING}
                sx={{ width: 160 }}
                inputProps={{ sx: MONO_SX }}
                data-testid="settings-automation-host-field"
              />
            </DisabledReason>
            <TextField
              size="small"
              fullWidth
              label="Access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              inputProps={{ sx: MONO_SX }}
              data-testid="settings-automation-token-field"
            />
          </Stack>
          <TextField
            size="small"
            fullWidth
            label="Client allowlist"
            value={allowlist}
            onChange={(e) => setAllowlist(e.target.value)}
            helperText="Comma-separated hosts allowed to connect; applied to the next connection."
            inputProps={{ sx: MONO_SX }}
            data-testid="settings-automation-allowlist-field"
          />
        </Stack>
      </RaisedPanel>

      <RaisedPanel
        icon={<BugReportIcon sx={{ color: "var(--warning)" }} />}
        title="Diagnostics"
        subtitle="Controls what the tool records about itself and exposes the resulting report."
        testId="settings-diagnostics-panel"
      >
        <Stack spacing={2}>
          <SwitchRow
            label="Collect frame statistics"
            caption="Per-service counters and jitter histograms; roughly 2 MB per hour of capture."
            checked={collectStats}
            onChange={setCollectStats}
            testId="settings-collect-stats-switch"
          />
          <SwitchRow
            label="Log SD state transitions"
            caption="Appends every service-discovery state change to the diagnostic report."
            checked={logSd}
            onChange={setLogSd}
            testId="settings-log-sd-switch"
          />
          <Box>
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
                Diagnostic report
              </Typography>
              <Tooltip title="Copy report">
                <IconButton
                  size="small"
                  aria-label="Copy report"
                  onClick={copyReport}
                  data-testid="settings-diag-copy-btn"
                >
                  <ContentCopyIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            </Stack>
            <TextField
              multiline
              fullWidth
              minRows={8}
              maxRows={16}
              value={DIAG_REPORT}
              InputProps={{ readOnly: true }}
              inputProps={{
                "aria-label": "Diagnostic report",
                sx: { ...MONO_SX, fontSize: 12.5 },
              }}
              data-testid="settings-diag-report-field"
            />
          </Box>
        </Stack>
      </RaisedPanel>

      <RaisedPanel
        icon={<MemoryIcon sx={{ color: "var(--success)" }} />}
        title="Memory"
        subtitle="Reports buffer usage and releases history that is no longer needed."
        testId="settings-memory-panel"
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={1}>
            {MEMORY_POOLS.map((p) => (
              <Chip
                key={p.id}
                size="small"
                variant="outlined"
                icon={<MemoryIcon />}
                label={p.label}
                sx={{ "& .MuiChip-label": { ...MONO_SX, fontSize: 12 } }}
                data-testid={`settings-memory-chip-${p.id}`}
              />
            ))}
          </Stack>
          <Box>
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<DeleteSweepIcon />}
              onClick={() => setConfirmOpen(true)}
              data-testid="settings-reclaim-btn"
            >
              Reclaim memory
            </Button>
            <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
              Releases trace history and decode caches; plotted signals keep only the visible
              window.
            </Typography>
          </Box>
        </Stack>
      </RaisedPanel>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle sx={{ fontSize: 20, fontWeight: 500 }}>Reclaim memory?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 14 }}>
            Trace history and decode caches are released immediately. Plotted signals keep only
            the currently visible window; this cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            size="small"
            onClick={() => setConfirmOpen(false)}
            data-testid="settings-reclaim-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            onClick={() => setConfirmOpen(false)}
            data-testid="settings-reclaim-confirm-btn"
          >
            Reclaim
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
