/**
 * Network view (SRS_visual_ui.md §5.8, §1.5): Connection panel from the
 * shared session store; Topology / SD / PTP show honest empty states until
 * live decode arrives. No fabricated ECUs, counters, or topology.
 */

import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import CellTowerIcon from "@mui/icons-material/CellTower";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import HubIcon from "@mui/icons-material/Hub";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import { useMemo } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import {
  droppedBreakdownTooltip,
  linkChipColorVar,
} from "../runtime/captureSource";
import {
  connectionPanelModel,
  NETWORK_EMPTY,
} from "../runtime/networkDisplay";
import { sessionStore } from "../runtime/sessionStore";
import { shallowEqual, useStoreSelector } from "../runtime/useStoreSelector";
import { useViewActive, useViewLifecycle } from "../shell/viewLifecycle";

const MONO = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
} as const;

function NetworkStatsChips(props: { active: boolean }) {
  const rawStats = useStoreSelector(sessionStore, (snapshot) => snapshot.stats, Object.is, props.active);
  if (!rawStats) return null;
  const snapshot = sessionStore.getSnapshot();
  const stats = connectionPanelModel({ ...snapshot, stats: rawStats }).stats;
  if (!stats) return null;
  const droppedWarning = stats.dropped > 0;
  const droppedTooltip = droppedBreakdownTooltip(rawStats);
  return (
    <>
      <Chip size="small" variant="outlined" label={`Received ${stats.received.toLocaleString("en-US")}`} data-testid="network-stat-received" />
      <Chip size="small" variant="outlined" label={`Emitted ${stats.emitted.toLocaleString("en-US")}`} data-testid="network-stat-emitted" />
      <Tooltip title={droppedTooltip}>
        <Chip size="small" variant="outlined" label={`Dropped ${stats.dropped.toLocaleString("en-US")}`} data-testid="network-stat-dropped"
          sx={droppedWarning ? { color: "var(--warning)", borderColor: "var(--warning)" } : undefined} />
      </Tooltip>
      <Chip size="small" variant="outlined" label={`Gaps ${stats.gaps.toLocaleString("en-US")}`} data-testid="network-stat-gaps" />
      <Chip size="small" variant="outlined" label={`Malformed ${stats.malformed.toLocaleString("en-US")}`} data-testid="network-stat-malformed" />
    </>
  );
}

function NetworkStatsDetails(props: { active: boolean }) {
  const rawStats = useStoreSelector(sessionStore, (snapshot) => snapshot.stats, Object.is, props.active);
  if (!rawStats) return null;
  const stats = connectionPanelModel({ ...sessionStore.getSnapshot(), stats: rawStats }).stats;
  if (!stats) return null;
  return (
    <>
      {stats.classLine ? (
        <Typography sx={{ ...MONO, fontSize: 12, color: "text.secondary" }} data-testid="network-stat-classes">{stats.classLine}</Typography>
      ) : null}
      {stats.caption ? (
        <Typography sx={{ fontSize: 12, color: "text.secondary" }} data-testid="network-stats-caption">{stats.caption}</Typography>
      ) : null}
    </>
  );
}

export function NetworkView() {
  useViewLifecycle("network", {});
  const active = useViewActive("network");
  const session = useStoreSelector(
    sessionStore,
    ({ running, sourceKind, simAddr, pcapPath, pcapStreamAddr, liveInterfaceId, linkStatus, sessionInfo }) =>
      ({ running, sourceKind, simAddr, pcapPath, pcapStreamAddr, liveInterfaceId, linkStatus, sessionInfo }),
    shallowEqual,
    active,
  );
  const model = useMemo(
    () =>
      connectionPanelModel({
        running: session.running,
        sourceKind: session.sourceKind,
        simAddr: session.simAddr,
        pcapPath: session.pcapPath,
        pcapStreamAddr: session.pcapStreamAddr,
        liveInterfaceId: session.liveInterfaceId,
        linkStatus: session.linkStatus,
        sessionInfo: session.sessionInfo,
        stats: null,
      }),
    [session],
  );

  const linkColor = model.linkState
    ? linkChipColorVar(model.linkState)
    : "var(--text-secondary)";
  return (
    <Stack spacing={2}>
      <RaisedPanel
        icon={<SettingsEthernetIcon sx={{ color: "var(--accent-primary)" }} />}
        title="Connection"
        subtitle="Everything the core is connected to in this session."
        testId="network-connection-panel"
      >
        <Stack spacing={2}>
          <Box>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }} data-testid="network-source-kind">
              {model.sourceLabel}
            </Typography>
            {model.address ? (
              <Typography
                sx={{ ...MONO, fontSize: 13, color: "text.secondary" }}
                data-testid="network-source-addr"
              >
                {model.address}
              </Typography>
            ) : null}
            {model.scenario ? (
              <Typography
                sx={{ fontSize: 13, color: "text.secondary" }}
                data-testid="network-source-scenario"
              >
                Scenario: {model.scenario}
              </Typography>
            ) : null}
            {model.timestampSource ? (
              <Typography
                sx={{ fontSize: 13, color: "text.secondary" }}
                data-testid="network-timestamp-source"
              >
                Timestamp source: {model.timestampSource}
              </Typography>
            ) : null}
          </Box>

          {model.stoppedHint ? (
            <Typography
              sx={{ fontSize: 14, color: "text.secondary" }}
              data-testid="network-stopped-hint"
            >
              {model.stoppedHint}
            </Typography>
          ) : null}

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              variant="outlined"
              icon={
                <FiberManualRecordIcon
                  sx={{
                    fontSize: 10,
                    color: model.running ? "var(--success)" : "var(--text-secondary)",
                  }}
                />
              }
              label={model.sessionChipLabel}
              data-testid="network-session-chip"
            />
            {model.linkChipLabel ? (
              <Chip
                size="small"
                variant="outlined"
                icon={
                  <FiberManualRecordIcon sx={{ fontSize: 10, color: linkColor }} />
                }
                label={model.linkChipLabel}
                data-testid="network-link-chip"
                sx={{
                  color: linkColor,
                  borderColor: linkColor,
                }}
              />
            ) : null}
            {model.linkDetail ? (
              <Typography
                sx={{ ...MONO, fontSize: 12, color: "text.secondary", alignSelf: "center" }}
                data-testid="network-link-detail"
              >
                {model.linkDetail}
              </Typography>
            ) : null}
            <NetworkStatsChips active={active} />
          </Stack>

          <NetworkStatsDetails active={active} />

          <Box sx={{ position: "relative", height: 36 }}>
            <EmptyState
              text={NETWORK_EMPTY.externalNodes}
              inset
              testId="network-external-nodes-empty"
            />
          </Box>
          <Box sx={{ position: "relative", height: 36 }}>
            <EmptyState
              text={NETWORK_EMPTY.automation}
              inset
              testId="network-automation-empty"
            />
          </Box>
        </Stack>
      </RaisedPanel>

      {/* NV-004 */}
      <RaisedPanel
        icon={<HubIcon sx={{ color: "var(--info)" }} />}
        title="Topology"
        subtitle="ECU nodes and subscription edges derived passively from observed SD traffic."
        testId="network-topology-panel"
      >
        <Box sx={{ position: "relative", height: 48 }}>
          <EmptyState text={NETWORK_EMPTY.topology} inset testId="network-topology-empty" />
        </Box>
      </RaisedPanel>

      {/* NV-004 */}
      <RaisedPanel
        icon={<CellTowerIcon sx={{ color: "var(--accent-secondary)" }} />}
        title="SD monitor"
        subtitle="Per-service discovery state with TTL countdowns; transitions will link to Trace."
        testId="network-sd-panel"
      >
        <Box sx={{ position: "relative", height: 48 }}>
          <EmptyState text={NETWORK_EMPTY.sdMonitor} inset testId="network-sd-empty" />
        </Box>
      </RaisedPanel>

      {/* NV-004 */}
      <RaisedPanel
        icon={<ScheduleIcon sx={{ color: "var(--series-16)" }} />}
        title="PTP"
        subtitle="gPTP sync tree; per-node offset and rate charts arrive with the graphing stack."
        testId="network-ptp-panel"
      >
        <Box sx={{ position: "relative", height: 48 }}>
          <EmptyState text={NETWORK_EMPTY.ptp} inset testId="network-ptp-empty" />
        </Box>
      </RaisedPanel>
    </Stack>
  );
}
