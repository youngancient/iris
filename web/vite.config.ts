import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Read VITE_* vars from the repo-root .env
export default defineConfig({ plugins: [react()], envDir: ".." });
