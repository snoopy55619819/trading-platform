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
});
