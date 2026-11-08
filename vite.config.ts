import { loadPublicInstanceConfig, renderInstanceHtml, instancePort } from "./server/instance-config";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const instance = command === "serve" ? loadPublicInstanceConfig(env) : undefined;
  return {
    // Relative chunk imports support a runtime BASE_PATH. The server rewrites initial HTML URLs.
    base: instance ? `${instance.basePath}/` : "./",
    plugins: [react(), { name: "instance-development-config", apply: "serve", transformIndexHtml(html: string) {
      return renderInstanceHtml(html, instance!);
    } }],
    server: { proxy: { [`${instance?.basePath ?? ''}/api`]: `http://127.0.0.1:${instancePort(env.PORT ?? 37821)}` } },
  };
});
