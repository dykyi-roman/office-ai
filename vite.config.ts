import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      $lib: "/src/lib",
    },
  },
  test: {
    // Run in Node environment (no browser/WebGL required for unit tests)
    environment: "node",
    // Include all test and bench files
    include: [
      "src/**/__tests__/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    // Benchmark files
    benchmark: {
      include: ["tests/benchmarks/**/*.bench.ts"],
      outputFile: "tests/benchmarks/results.json",
    },
    // Resolve $lib alias in tests
    alias: {
      $lib: new URL("./src/lib", import.meta.url).pathname,
    },
    // Global test utilities available without explicit import
    globals: false,
    // Report test results in verbose mode
    reporter: "verbose",
    // Coverage configuration (run with --coverage flag)
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/__tests__/**",
        "src/lib/types/**",
        "src/lib/**/index.ts",
        "src/**/*.svelte",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
}));
