import { Box, Dialog, DialogContent, Typography } from "@mui/material";
import radeauMark from "../assets/radeau-mark.png";
import { appInfoStore } from "../runtime/appInfoStore";
import { useStoreSelector } from "../runtime/useStoreSelector";

/**
 * About modal (SRS_visual_ui.md §4.4): product mark, name, one-line
 * description, and version / build profile / OS from `app_info`.
 */
export function AboutDialog(props: { open: boolean; onClose: () => void }) {
  const info = useStoreSelector(appInfoStore, (snapshot) => snapshot.info);

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="xs" data-testid="about-dialog">
      <DialogContent sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, p: 4 }}>
        <Box component="img" src={radeauMark} alt="" aria-hidden sx={{ width: 64, height: 64 }} />
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
          <span>version</span>
          <span data-testid="about-version">{info.version}</span>
          <span>build</span>
          <span data-testid="about-build">{info.buildProfile}</span>
          <span>os</span>
          <span data-testid="about-os">{info.os}</span>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
