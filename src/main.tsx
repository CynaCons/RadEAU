// Must stay the first import: it has to run before react-dom evaluates.
import "./devPerfTracks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled with the application (VU-006), never referenced by name
// and hoped for.
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Startup overlay (VU-025): painted by index.html before any framework code;
// removed here after mount via a 220 ms fade.
requestAnimationFrame(() => {
  const overlay = document.getElementById("startup-overlay");
  if (!overlay) return;
  overlay.classList.add("fading");
  window.setTimeout(() => overlay.remove(), 240);
});
