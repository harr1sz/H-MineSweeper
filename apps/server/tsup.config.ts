import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  removeNodeProtocol: false,
  noExternal: ["@h-minesweeper/game-core"],
});
