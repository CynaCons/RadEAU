/**
 * Network view (SRS_visual_ui.md §5.8, §1.5): Connection panel from the
 * shared session store; Topology / SD / PTP show honest empty states until
 * live decode arrives. No fabricated ECUs, counters, or topology.
 */

import { Box, Chip, Stack, Typography } from "@mui/material";
import CellTowerIcon from "@mui/icons-material/CellTower";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import HubIcon from "@mui/icons-material/Hub";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet";
import { useMemo, useSyncExternalStore } from "react";
import { EmptyState } from "../components/EmptyState";
import { RaisedPanel } from "../components/RaisedPanel";
import { linkChipColorVar } from "../runtime/captureSource";
import {
  connectionPanelModel,
  NETWORK_EMPTY,
} from "../runtime/networkDisplay";
import { sessionStore } from "../runtime/sessionStore";
import { useViewLifecycle } from "../shell/viewLifecycle";

const MONO = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
} as const;

export function NetworkView() {
  useViewLifecycle("network", {});
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const model = useMemo(
    () =>
      connectionPanelModel({
        running: session.running,
        sourceKind: session.sourceKind,
        simAddr: session.simAddr,
        linkStatus: session.linkStatus,
        sessionInfo: session.sessionInfo,
        stats: session.stats,
      }),
    [session],
  );

  const linkColor = model.linkState
    ? linkChipColorVar(model.linkState)
    : "var(--text-secondary)";
  const stats = model.stats;
  const droppedWarning = stats !== null && stats.dropped > 0;

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
            {stats ? (
              <>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Received ${stats.received.toLocaleString("en-US")}`}
                  data-testid="network-stat-received"
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Emitted ${stats.emitted.toLocaleString("en-US")}`}
                  data-testid="network-stat-emitted"
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Dropped ${stats.dropped.toLocaleString("en-US")}`}
                  data-testid="network-stat-dropped"
                  sx={
                    droppedWarning
                      ? { color: "var(--warning)", borderColor: "var(--warning)" }
                      : undefined
                  }
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Gaps ${stats.gaps.toLocaleString("en-US")}`}
                  data-testid="network-stat-gaps"
                />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`Malformed ${stats.malformed.toLocaleString("en-US")}`}
                  data-testid="network-stat-malformed"
                />
              </>
            ) : null}
          </Stack>

          {stats?.classLine ? (
            <Typography
              sx={{ ...MONO, fontSize: 12, color: "text.secondary" }}
              data-testid="network-stat-classes"
            >
              {stats.classLine}
            </Typography>
          ) : null}
          {stats?.caption ? (
            <Typography
              sx={{ fontSize: 12, color: "text.secondary" }}
              data-testid="network-stats-caption"
            >
              {stats.caption}
            </Typography>
          ) : null}

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
