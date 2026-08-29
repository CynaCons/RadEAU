/**
 * Settings view (SRS_visual_ui.md §5.7): Interface is the only place the
 * capture source is chosen; groups whose core has not landed render disabled
 * with a caption naming the arriving version.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
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
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import SpeedIcon from "@mui/icons-material/Speed";
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { RaisedPanel } from "../components/RaisedPanel";
import {
  interfaceLockedReason,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
  type SourceKind,
} from "../runtime/captureSource";
import { isDesktop } from "../runtime/desktop";
import { sessionStore } from "../runtime/sessionStore";
import { useViewLifecycle } from "../shell/viewLifecycle";

// ── Local state for groups not yet wired to the core (PRD §6). ──

const REFRESH_OPTIONS = [
  { value: 16, label: "16 ms (60 Hz)" },
  { value: 33, label: "33 ms (30 Hz)" },
  { value: 100, label: "100 ms (10 Hz)" },
];

const DIAG_REPORT = [
  "RadEAU diagnostic report",
  "generated   —",
  "build       —",
  "channel     —",
  "uptime      —",
  "",
  "(live diagnostic collection arrives with the diagnostics core)",
].join("\n");

const MEMORY_POOLS = [
  { id: "ring", label: "Ring buffers — —" },
  { id: "decode", label: "Decode cache — —" },
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
  disabled?: boolean;
}) {
  const { label, caption, checked, onChange, testId, disabled = false } = props;
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Switch
          size="small"
          checked={checked}
          disabled={disabled}
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
  const desktop = isDesktop();
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const controlsLocked = sourceControlsDisabled(session.running);
  const lockReason = interfaceLockedReason(session.running) ?? "";
  const simOk = simSourceAvailable(desktop);

  const [transmitOnly, setTransmitOnly] = useState(false);
  const [refreshMs] = useState(33);

  const copyReport = () => {
    void navigator.clipboard?.writeText(DIAG_REPORT);
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 800 }}>
      <RaisedPanel
        icon={<SettingsEthernetIcon sx={{ color: "var(--accent-primary)" }} />}
        title="Interface"
        subtitle="Selects the capture source RadEAU attaches to and how frames may leave the tool."
        testId="settings-interface-panel"
      >
        <Stack spacing={2}>
          <DisabledReason disabled={controlsLocked} reason={lockReason}>
            <TextField
              select
              size="small"
              fullWidth
              label="Capture source"
              value={session.sourceKind}
              disabled={controlsLocked}
              onChange={(e) => {
                const next = e.target.value as SourceKind;
                if (next === "sim" && !simOk) return;
                sessionStore.setSourceKind(next);
              }}
              data-testid="settings-source-select"
            >
              <MenuItem value="devgen" data-testid="settings-source-option-devgen">
                Dev generator
              </MenuItem>
              <MenuItem
                value="sim"
                disabled={!simOk}
                title={simOk ? undefined : "desktop app only"}
                data-testid="settings-source-option-sim"
              >
                Simulator link
              </MenuItem>
            </TextField>
          </DisabledReason>
          {session.lastError ? (
            <Alert severity="error" data-testid="settings-start-error">
              {session.lastError}
            </Alert>
          ) : null}
          {showSimAddressField(session.sourceKind) ? (
            <DisabledReason disabled={controlsLocked} reason={lockReason}>
              <TextField
                size="small"
                fullWidth
                label="Address"
                value={session.simAddr}
                disabled={controlsLocked}
                onChange={(e) => sessionStore.setSimAddr(e.target.value)}
                inputProps={{
                  "aria-label": "Simulator monitor address",
                  sx: MONO_SX,
                }}
                data-testid="settings-sim-addr"
              />
            </DisabledReason>
          ) : null}
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
            disabled
            helperText="arrives v0.8"
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
            caption="arrives v0.8"
            checked={false}
            onChange={() => {}}
            testId="settings-low-overhead-switch"
            disabled
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
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>arrives v0.7</Typography>
          <Stack direction="row" spacing={2}>
            <TextField
              size="small"
              label="Port"
              value=""
              disabled
              sx={{ width: 96 }}
              inputProps={{ sx: MONO_SX }}
              data-testid="settings-automation-port-field"
            />
            <TextField
              size="small"
              label="Bind host"
              value=""
              disabled
              sx={{ width: 160 }}
              inputProps={{ sx: MONO_SX }}
              data-testid="settings-automation-host-field"
            />
            <TextField
              size="small"
              fullWidth
              label="Access token"
              value=""
              disabled
              inputProps={{ sx: MONO_SX }}
              data-testid="settings-automation-token-field"
            />
          </Stack>
          <TextField
            size="small"
            fullWidth
            label="Client allowlist"
            value=""
            disabled
            helperText="arrives v0.7"
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
            caption="arrives v0.1.6"
            checked={false}
            onChange={() => {}}
            testId="settings-collect-stats-switch"
            disabled
          />
          <SwitchRow
            label="Log SD state transitions"
            caption="arrives v0.1.6"
            checked={false}
            onChange={() => {}}
            testId="settings-log-sd-switch"
            disabled
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
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>arrives v0.8</Typography>
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
              disabled
              data-testid="settings-reclaim-btn"
            >
              Reclaim memory
            </Button>
            <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
              arrives v0.8
            </Typography>
          </Box>
        </Stack>
      </RaisedPanel>
    </Stack>
  );
}
