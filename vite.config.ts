import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite only needs the React plugin here; Cloudflare runs through the npm scripts.
export default defineConfig({
  plugins: [react()],
});
