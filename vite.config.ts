import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const client = resolve(root, "client");
const backend = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;

export default defineConfig(({ command }) => ({
  root: client,
  base: command === "build" ? "/build/" : "/",
  publicDir: false,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      ["/api", "/images", "/fonts", "/icons.svg", "/favicon.svg", "/apple-touch-icon.png", "/login-preview.svg"].map((path) => [
        path,
        { target: backend, changeOrigin: false },
      ]),
    ),
  },
  build: {
    outDir: resolve(root, "public/build"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(client, "index.html"),
        login: resolve(client, "login.html"),
      },
    },
  },
}));
