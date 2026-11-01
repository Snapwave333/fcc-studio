import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("@codemirror/lang-") || id.includes("@lezer/")) return undefined;
          if (id.includes("@codemirror") || id.includes("@uiw") || id.includes("crelt") || id.includes("style-mod") || id.includes("w3c-keyname")) return "codemirror";
          if (id.includes("react") || id.includes("scheduler") || id.includes("zustand")) return "react";
          if (id.includes("lucide")) return "icons";
          return "vendor";
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
