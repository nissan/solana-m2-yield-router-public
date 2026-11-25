import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page. Built into dist-web/, which the server serves; there is no separate development server to run.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist-web", emptyOutDir: true },
});
