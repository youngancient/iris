import { configDefaults, defineConfig } from "vitest/config";

// Skip compiled copies of the tests in dist/.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "dist/**"] } });
