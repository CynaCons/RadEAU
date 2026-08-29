import { Box, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { AUTOMATION_EMPTY } from "../runtime/automationDisplay";
import { useViewLifecycle } from "../shell/viewLifecycle";

interface ConsoleLine {
  t: number;
  text: string;
  stderr?: boolean;
}

/**
 * Automation view (SRS_visual_ui.md §5.5): honest empty script list and an
 * empty console until the automation surface lands in v0.7 — no fabricated
 * scripts, console output, or run/stop/delete actions.
 */
export function AutomationView() {
  useViewLifecycle("automation", {});
  const [lines, setLines] = useState<ConsoleLine[]>([]);
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
        <EmptyState text={AUTOMATION_EMPTY} testId="automation-empty" />
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
            console
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
          {lines.map((line, i) => (
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
          ))}
        </Box>
      </Box>
    </Box>
  );
}
