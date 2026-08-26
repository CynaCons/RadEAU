import { Box, Dialog, DialogContent, Typography } from "@mui/material";

/**
 * About modal (SRS_visual_ui.md §4.4): product mark, name, one-line
 * description, and a two-column grid with build tag and commit hash in
 * font-mono. Build info is injected at build time later; dev placeholders
 * until then.
 */
export function AboutDialog(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="xs" data-testid="about-dialog">
      <DialogContent sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, p: 4 }}>
        <svg viewBox="0 0 96 96" width="64" height="64" aria-hidden="true">
          <circle cx="48" cy="48" r="42" fill="none" stroke="var(--accent-primary)" strokeWidth="5" />
          <polyline
            points="16,48 34,48 42,26 54,70 62,48 80,48"
            fill="none"
            stroke="var(--info)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <Typography sx={{ fontSize: 20, fontWeight: 500 }}>RadEAU</Typography>
        <Typography sx={{ fontSize: 14, color: "text.secondary", textAlign: "center" }}>
          High-performance automotive Ethernet network analysis — SOME/IP, SOME/IP-SD, gPTP.
        </Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "auto auto",
            columnGap: 3,
            rowGap: 0.5,
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            color: "text.secondary",
          }}
        >
          <span>build</span>
          <span data-testid="about-build-tag">dev</span>
          <span>commit</span>
          <span data-testid="about-commit-hash">workspace</span>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
