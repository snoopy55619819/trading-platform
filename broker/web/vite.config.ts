// The web client's build: a static bundle (HTML, JS, CSS) in dist/, served by anything.
// In development, `pnpm dev` serves it on http://localhost:5173, the origin the backend's
// CORS allowlist expects by default.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail rather than move to another port: the backend only allows this origin.
    strictPort: true,
  },
  optimizeDeps: {
    // Bundled up front rather than discovered on first load: a dependency found mid-session
    // makes Vite re-bundle and reload, and for a moment the page can hold two copies of
    // React ("Invalid hook call"). Add runtime libraries here as they are added.
    include: ["react", "react-dom/client", "@tanstack/react-query"],
  },
});
