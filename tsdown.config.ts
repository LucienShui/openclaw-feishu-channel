import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./api.ts",
    "./channel-entry.ts",
    "./channel-plugin-api.ts",
    "./contract-api.ts",
    "./index.ts",
    "./legacy-state-migrations-api.ts",
    "./runtime-api.ts",
    "./runtime-setter-api.ts",
    "./secret-contract-api.ts",
    "./security-contract-api.ts",
    "./session-binding-contract-api.ts",
    "./session-key-api.ts",
    "./setup-api.ts",
    "./setup-entry.ts",
    "./subagent-hooks-api.ts",
    "./src/**/*.ts",
  ],
  clean: true,
  dts: false,
  fixedExtension: false,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [/^openclaw\//u, "@larksuiteoapi/node-sdk", "typebox", "zod"],
});
