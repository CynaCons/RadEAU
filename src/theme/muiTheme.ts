import { createTheme } from "@mui/material/styles";
import tokensJson from "./tokens.json";

/**
 * The MUI theme is a MIRROR of the token source (src/theme/tokens.json) —
 * never a second place where colors are decided (VU-002). Flat surfaces:
 * elevation tinting is disabled globally (VU-003). Motion policy
 * (SRS_visual_ui.md §8): no ripple anywhere; transitions on hot-path
 * components are opted out per component, not per style.
 */

export const color = tokensJson.color as Record<string, string>;
const token = (name: string): string => color[name]!;
const fontUi = tokensJson.font.ui;
// The series palette (tokens.series) is consumed via CSS vars until the chart
// engine lands in v0.2; re-export from here when a TS consumer appears.

export const muiTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: token("surface-canvas"),
      paper: token("surface-raised"),
    },
    primary: { main: token("accent-primary"), dark: token("accent-primary-dark") },
    secondary: { main: token("accent-secondary"), dark: token("accent-secondary-dark") },
    info: { main: token("info"), dark: token("info-dark") },
    success: { main: token("success"), dark: token("success-dark") },
    warning: { main: token("warning"), dark: token("warning-dark") },
    error: { main: token("error"), dark: token("error-dark") },
    divider: token("border"),
    text: {
      primary: token("text-primary"),
      secondary: token("text-secondary"),
    },
  },
  typography: {
    fontFamily: fontUi,
    fontSize: 14,
    body1: { fontSize: 14 },
    body2: { fontSize: 12 },
    caption: { fontSize: 12 },
  },
  shape: { borderRadius: 4 },
  components: {
    // VU-003: no depth-based background tinting anywhere.
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: "none" } },
    },
    // Motion policy: no ripple, ever.
    MuiButtonBase: {
      defaultProps: { disableRipple: true, disableTouchRipple: true },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: "none" } },
    },
    MuiTooltip: {
      defaultProps: { arrow: false, enterDelay: 500 },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: color["fill-subtle"],
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: color["border-hairline"],
          },
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: color["border-hairline-hover"],
          },
        },
      },
    },
  },
});
