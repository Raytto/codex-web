import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/codex-web/",
  plugins: [react()],
  server: {
    proxy: {
      "/codex-web/api": "http://127.0.0.1:37821",
    },
  },
});
