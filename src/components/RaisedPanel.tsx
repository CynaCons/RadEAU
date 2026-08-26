import { Box, Divider, Typography } from "@mui/material";
import type { ReactNode } from "react";

/**
 * The standard raised panel (SRS_visual_ui.md §5.3/§5.7): 24 px padding on
 * surface-raised with a 1 px border, opening with a colored icon beside a
 * 20 px / 500 title over a full-width divider. Optional mandatory-style
 * subtitle sentence (Settings-style groups) and an accent left rule
 * (e.g. 3 px error while recording).
 */
export function RaisedPanel(props: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  leftRule?: string;
  testId?: string;
  children?: ReactNode;
}) {
  const { icon, title, subtitle, leftRule, testId, children } = props;
  return (
    <Box
      data-testid={testId}
      sx={{
        p: "24px",
        bgcolor: "background.paper",
        border: "1px solid var(--border)",
        borderLeft: leftRule ? `3px solid ${leftRule}` : "1px solid var(--border)",
        borderRadius: 1,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        {icon}
        <Typography sx={{ fontSize: 20, fontWeight: 500 }}>{title}</Typography>
      </Box>
      {subtitle ? (
        <Typography sx={{ fontSize: 14, color: "text.secondary", mt: 0.5 }}>{subtitle}</Typography>
      ) : null}
      <Divider sx={{ my: 1.5 }} />
      {children}
    </Box>
  );
}
