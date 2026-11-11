import "./theme/tokens.css";
import "./theme/layout.css";
import "./ui/controls.css";
import "./ui/table.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { startMarketData } from "./market/hooks.ts";

// One live feed for the whole app, opened once. Prices are public: no session needed.
startMarketData();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
