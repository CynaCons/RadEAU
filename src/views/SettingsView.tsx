/**
 * Settings view (SRS_visual_ui.md §5.7): Interface is the only place the
 * capture source is chosen; Dependencies and Diagnostics are live probes;
 * groups whose core has not landed render disabled with a caption naming
 * the arriving version.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import BugReportIcon from "@mui/icons-material/BugReport";
import CodeIcon from "@mui/icons-material/Code";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import ExtensionIcon from "@mui/icons-material/Extension";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import MemoryIcon from "@mui/icons-material/Memory";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import SpeedIcon from "@mui/icons-material/Speed";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { RaisedPanel } from "../components/RaisedPanel";
import {
  DEFAULT_LIVE_BPF_FILTER,
  interfaceLockedReason,
  liveInterfacePrimaryLabel,
  liveInterfaceSecondaryText,
  liveSourceAvailable,
  liveSourceDisabledReason,
  pcapPaceCaption,
  pcapSourceAvailable,
  showLiveInterfaceFields,
  showPcapPathField,
  showPcapStreamAddrField,
  showSimAddressField,
  simSourceAvailable,
  sourceControlsDisabled,
  type InterfaceInfo,
  type PcapPace,
  type SourceKind,
} from "../runtime/captureSource";
import {
  dependencyChipModel,
  dependencyPathLine,
  liveCaptureDependency,
  liveCapturePlatform,
  type DependencyRow,
} from "../runtime/dependencyDisplay";
import { appInfoStore } from "../runtime/appInfoStore";
import {
  dependencyProbe,
  diagnosticsReport,
  isDesktop,
  listInterfaces,
  logPath,
  openUrl,
  pickPcapFile,
} from "../runtime/desktop";
import { sessionStore } from "../runtime/sessionStore";
import { shallowEqual, useStoreSelector } from "../runtime/useStoreSelector";
import { useViewActive, useViewLifecycle } from "../shell/viewLifecycle";

// ── Local state for groups not yet wired to the core (PRD §6). ──

const REFRESH_OPTIONS = [
  { value: 16, label: "16 ms (60 Hz)" },
  { value: 33, label: "33 ms (30 Hz)" },
  { value: 100, label: "100 ms (10 Hz)" },
];

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

function DependencyRowView(props: { row: DependencyRow }) {
  const { row } = props;
  const chip = dependencyChipModel(row);
  const pathLine = dependencyPathLine(row);
  return (
    <Box
      data-testid={`settings-dep-row-${row.id}`}
      sx={{
        py: 1.5,
        borderBottom: "1px solid var(--border)",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 500 }}>{row.name}</Typography>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
            enables {row.enables}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={chip.label}
            data-testid={`settings-dep-status-${row.id}`}
            sx={{
              mt: 0.75,
              height: 22,
              fontSize: 12,
              color: chip.colorVar,
              borderColor: chip.colorVar,
            }}
          />
          {pathLine ? (
            <Typography
              sx={{ ...MONO_SX, fontSize: 12, color: "text.secondary", mt: 0.5 }}
              data-testid={`settings-dep-path-${row.id}`}
            >
              {pathLine}
            </Typography>
          ) : null}
          {row.detail ? (
            <Typography
              sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}
              data-testid={`settings-dep-detail-${row.id}`}
            >
              {row.detail}
            </Typography>
          ) : null}
        </Box>
        {chip.showDownload ? (
          <Button
            size="small"
            variant="outlined"
            startIcon={<OpenInNewIcon />}
            onClick={() => {
              void openUrl(row.downloadUrl);
            }}
            data-testid={`settings-dep-download-${row.id}`}
            sx={{ flexShrink: 0 }}
          >
            Open download page
          </Button>
        ) : null}
      </Stack>
    </Box>
  );
}

export function SettingsView() {
  useViewLifecycle("settings", {});
  const active = useViewActive("settings");
  const desktop = isDesktop();
  const session = useStoreSelector(
    sessionStore,
    ({ running, sourceKind, simAddr, pcapPath, pcapPace, pcapStreamAddr, liveInterfaceId, liveFilter, lastError }) =>
      ({ running, sourceKind, simAddr, pcapPath, pcapPace, pcapStreamAddr, liveInterfaceId, liveFilter, lastError }),
    shallowEqual,
    active,
  );
  const appInfo = useStoreSelector(appInfoStore, (snapshot) => snapshot.info);
  const controlsLocked = sourceControlsDisabled(session.running);
  const lockReason = interfaceLockedReason(session.running) ?? "";
  const simOk = simSourceAvailable(desktop);
  const pcapOk = pcapSourceAvailable(desktop);
  const showDevgen = appInfo.devgenAvailable;

  const [transmitOnly, setTransmitOnly] = useState(false);
  const [refreshMs] = useState(33);

  const [deps, setDeps] = useState<DependencyRow[] | null>(null);
  const [depsLoading, setDepsLoading] = useState(false);
  const [depsError, setDepsError] = useState<string | null>(null);

  const [diagReport, setDiagReport] = useState("");
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [appLogPath, setAppLogPath] = useState("");

  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [ifacesLoading, setIfacesLoading] = useState(false);
  const [ifacesError, setIfacesError] = useState<string | null>(null);

  const liveDep = liveCaptureDependency(deps);
  const liveOk = liveSourceAvailable(desktop, liveDep?.status);
  const liveDisabledReason = liveSourceDisabledReason(liveCapturePlatform(deps));

  const loadDeps = useCallback(async () => {
    setDepsLoading(true);
    setDepsError(null);
    try {
      const rows = await dependencyProbe();
      setDeps(rows);
    } catch (err) {
      setDeps(null);
      setDepsError(
        err instanceof Error ? err.message : typeof err === "string" ? err : String(err),
      );
    } finally {
      setDepsLoading(false);
    }
  }, []);

  const loadDiag = useCallback(async () => {
    setDiagLoading(true);
    setDiagError(null);
    try {
      const [report, path] = await Promise.all([diagnosticsReport(), logPath()]);
      setDiagReport(report);
      setAppLogPath(path);
    } catch (err) {
      setDiagError(
        err instanceof Error ? err.message : typeof err === "string" ? err : String(err),
      );
    } finally {
      setDiagLoading(false);
    }
  }, []);

  const loadInterfaces = useCallback(async () => {
    setIfacesLoading(true);
    setIfacesError(null);
    try {
      const list = await listInterfaces();
      setInterfaces(list);
    } catch (err) {
      setInterfaces([]);
      setIfacesError(
        err instanceof Error ? err.message : typeof err === "string" ? err : String(err),
      );
    } finally {
      setIfacesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDeps();
    void loadDiag();
  }, [loadDeps, loadDiag]);

  useEffect(() => {
    if (session.sourceKind === "live" && liveOk) {
      void loadInterfaces();
    }
  }, [session.sourceKind, liveOk, loadInterfaces]);

  const copyReport = () => {
    void navigator.clipboard
      ?.writeText(diagReport)
      .catch((err: unknown) => console.warn("Failed to copy diagnostics report", err));
  };

  const browsePcap = async () => {
    const path = await pickPcapFile();
    if (path) sessionStore.setPcapPath(path);
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
                if ((next === "pcap" || next === "pcapStream") && !pcapOk) return;
                if (next === "live" && !liveOk) return;
                sessionStore.setSourceKind(next);
              }}
              data-testid="settings-source-select"
            >
              {showDevgen ? (
                <MenuItem value="devgen" data-testid="settings-source-option-devgen">
                  Dev generator
                </MenuItem>
              ) : null}
              <MenuItem
                value="sim"
                disabled={!simOk}
                title={simOk ? undefined : "desktop app only"}
                data-testid="settings-source-option-sim"
              >
                Simulator link
              </MenuItem>
              <MenuItem
                value="pcap"
                disabled={!pcapOk}
                title={pcapOk ? undefined : "desktop app only"}
                data-testid="settings-source-option-pcap"
              >
                pcap file
              </MenuItem>
              <MenuItem
                value="pcapStream"
                disabled={!pcapOk}
                title={pcapOk ? undefined : "desktop app only"}
                data-testid="settings-source-option-pcapstream"
              >
                pcap stream
              </MenuItem>
              <MenuItem
                value="live"
                disabled={!liveOk}
                title={liveOk ? undefined : liveDisabledReason}
                data-testid="settings-source-option-live"
              >
                Physical interface
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
          {showPcapPathField(session.sourceKind) ? (
            <Stack spacing={1.5}>
              <DisabledReason disabled={controlsLocked} reason={lockReason}>
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    fullWidth
                    label="pcap path"
                    value={session.pcapPath}
                    disabled={controlsLocked}
                    onChange={(e) => sessionStore.setPcapPath(e.target.value)}
                    placeholder="path to .pcap or .pcapng"
                    inputProps={{
                      "aria-label": "pcap file path",
                      sx: MONO_SX,
                    }}
                    data-testid="settings-pcap-path"
                  />
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<FolderOpenIcon />}
                    disabled={controlsLocked}
                    onClick={() => {
                      void browsePcap();
                    }}
                    data-testid="settings-pcap-browse"
                  >
                    Browse
                  </Button>
                </Stack>
              </DisabledReason>
              <DisabledReason disabled={controlsLocked} reason={lockReason}>
                <Box>
                  <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 0.5 }}>
                    Pace
                  </Typography>
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={session.pcapPace}
                    disabled={controlsLocked}
                    onChange={(_, value: PcapPace | null) => {
                      if (value) sessionStore.setPcapPace(value);
                    }}
                    data-testid="settings-pcap-pace"
                  >
                    <ToggleButton value="realtime" data-testid="settings-pcap-pace-realtime">
                      realtime
                    </ToggleButton>
                    <ToggleButton value="fast" data-testid="settings-pcap-pace-fast">
                      fast
                    </ToggleButton>
                  </ToggleButtonGroup>
                  <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
                    {pcapPaceCaption(session.pcapPace)}
                  </Typography>
                </Box>
              </DisabledReason>
            </Stack>
          ) : null}
          {showPcapStreamAddrField(session.sourceKind) ? (
            <DisabledReason disabled={controlsLocked} reason={lockReason}>
              <TextField
                size="small"
                fullWidth
                label="Stream address"
                value={session.pcapStreamAddr}
                disabled={controlsLocked}
                onChange={(e) => sessionStore.setPcapStreamAddr(e.target.value)}
                placeholder="host:port"
                inputProps={{
                  "aria-label": "pcap stream host:port",
                  sx: MONO_SX,
                }}
                data-testid="settings-pcapstream-addr"
              />
            </DisabledReason>
          ) : null}
          {showLiveInterfaceFields(session.sourceKind) ? (
            <Stack spacing={1.5}>
              <DisabledReason disabled={controlsLocked} reason={lockReason}>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <TextField
                    select
                    size="small"
                    fullWidth
                    label="Interface"
                    value={session.liveInterfaceId}
                    disabled={controlsLocked || ifacesLoading}
                    onChange={(e) => sessionStore.setLiveInterfaceId(e.target.value)}
                    data-testid="settings-live-interface"
                    SelectProps={{
                      displayEmpty: true,
                      renderValue: (selected) => {
                        const id = String(selected ?? "");
                        if (!id) return "Select an interface";
                        const iface = interfaces.find((i) => i.id === id);
                        return iface ? liveInterfacePrimaryLabel(iface) : id;
                      },
                    }}
                  >
                    <MenuItem value="" disabled>
                      {ifacesLoading
                        ? "Loading…"
                        : interfaces.length === 0
                          ? "No interfaces"
                          : "Select an interface"}
                    </MenuItem>
                    {interfaces.map((iface, index) => {
                        const secondary = liveInterfaceSecondaryText(iface);
                        return (
                          <MenuItem
                            key={iface.id}
                            value={iface.id}
                            data-testid={`settings-live-option-${index}`}
                          >
                            <Box sx={{ py: 0.25, minWidth: 0 }}>
                              <Typography sx={{ fontSize: 14 }}>
                                {liveInterfacePrimaryLabel(iface)}
                              </Typography>
                              {secondary ? (
                                <Typography
                                  sx={{
                                    ...MONO_SX,
                                    fontSize: 12,
                                    color: "text.secondary",
                                  }}
                                >
                                  {secondary}
                                </Typography>
                              ) : null}
                              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                                {iface.loopback ? (
                                  <Chip size="small" variant="outlined" label="loopback" sx={{ height: 20, fontSize: 11 }} />
                                ) : null}
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={iface.up ? "up" : "down"}
                                  sx={{
                                    height: 20,
                                    fontSize: 11,
                                    color: iface.up ? "var(--success)" : "var(--text-secondary)",
                                    borderColor: iface.up
                                      ? "var(--success)"
                                      : "var(--text-secondary)",
                                  }}
                                />
                              </Stack>
                            </Box>
                          </MenuItem>
                        );
                      })}
                  </TextField>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={
                      ifacesLoading ? (
                        <CircularProgress size={14} color="inherit" />
                      ) : (
                        <RefreshIcon />
                      )
                    }
                    disabled={controlsLocked || ifacesLoading}
                    onClick={() => {
                      void loadInterfaces();
                    }}
                    data-testid="settings-live-refresh"
                    sx={{ flexShrink: 0, mt: "2px" }}
                  >
                    Refresh
                  </Button>
                </Stack>
              </DisabledReason>
              {ifacesError ? (
                <Alert severity="error" data-testid="settings-live-error">
                  {ifacesError}
                </Alert>
              ) : null}
              <DisabledReason disabled={controlsLocked} reason={lockReason}>
                <TextField
                  size="small"
                  fullWidth
                  label="BPF filter"
                  value={session.liveFilter}
                  disabled={controlsLocked}
                  onChange={(e) => sessionStore.setLiveFilter(e.target.value)}
                  placeholder={DEFAULT_LIVE_BPF_FILTER}
                  helperText="leave empty for the default"
                  inputProps={{
                    "aria-label": "BPF filter",
                    sx: MONO_SX,
                  }}
                  data-testid="settings-live-filter"
                />
              </DisabledReason>
            </Stack>
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
        icon={<ExtensionIcon sx={{ color: "var(--accent-secondary)" }} />}
        title="Dependencies"
        subtitle="Runtime dependencies of the capture backends — presence, version, and where to get them."
        testId="settings-dependencies-panel"
      >
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              Read-only probes — never loads a capture driver
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={
                depsLoading ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />
              }
              disabled={depsLoading}
              onClick={() => {
                void loadDeps();
              }}
              data-testid="settings-deps-refresh"
            >
              Refresh
            </Button>
          </Stack>
          {depsError ? (
            <Alert severity="error" data-testid="settings-deps-error">
              {depsError}
            </Alert>
          ) : null}
          {depsLoading && deps === null ? (
            <Typography sx={{ fontSize: 13, color: "text.secondary" }} data-testid="settings-deps-loading">
              Probing…
            </Typography>
          ) : null}
          {deps?.map((row) => (
            <DependencyRowView key={row.id} row={row} />
          ))}
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
            caption="arrives v0.6"
            checked={false}
            onChange={() => {}}
            testId="settings-collect-stats-switch"
            disabled
          />
          <SwitchRow
            label="Log SD state transitions"
            caption="arrives v0.6"
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
              <Stack direction="row" spacing={0.5}>
                <Tooltip title="Refresh report">
                  <IconButton
                    size="small"
                    aria-label="Refresh report"
                    disabled={diagLoading}
                    onClick={() => {
                      void loadDiag();
                    }}
                    data-testid="settings-diag-refresh"
                  >
                    {diagLoading ? (
                      <CircularProgress size={14} color="inherit" />
                    ) : (
                      <RefreshIcon fontSize="inherit" />
                    )}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Copy report">
                  <IconButton
                    size="small"
                    aria-label="Copy report"
                    onClick={copyReport}
                    data-testid="settings-diag-copy"
                  >
                    <ContentCopyIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Stack>
            {diagError ? (
              <Alert severity="error" sx={{ mb: 1 }} data-testid="settings-diag-error">
                {diagError}
              </Alert>
            ) : null}
            <TextField
              multiline
              fullWidth
              minRows={8}
              maxRows={16}
              value={diagReport}
              InputProps={{ readOnly: true }}
              inputProps={{
                "aria-label": "Diagnostic report",
                sx: { ...MONO_SX, fontSize: 12.5 },
              }}
              data-testid="settings-diag-report-field"
            />
          </Box>
          <Typography
            sx={{ ...MONO_SX, fontSize: 12, color: "text.secondary" }}
            data-testid="settings-log-path"
          >
            Log path: {appLogPath || "—"}
          </Typography>
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
