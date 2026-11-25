import "@ui-sdk/core/web.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { httpApi } from "./api.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={httpApi} />
  </StrictMode>,
);
