import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

test("all checked-in release defaults keep the duel experiment off", async () => {
  const [
    compose,
    webDockerfile,
    rootEnvironment,
    serverEnvironment,
    webBuildConfig,
    rootPackage,
    serverPackage,
  ] = await Promise.all([
    text("compose.alpha.yml"),
    text("Dockerfile.web"),
    text(".env.example"),
    text("apps/server/.env.example"),
    text("apps/web/src/lib/build-config.ts"),
    text("package.json"),
    text("apps/server/package.json"),
  ]);

  assert.doesNotMatch(
    compose,
    /H_MINESWEEPER_DUEL_EXPERIMENT:-true/,
  );
  assert.match(
    compose,
    /H_MINESWEEPER_DUEL_EXPERIMENT:-false/,
  );
  assert.match(webDockerfile, /ARG VITE_DUEL_EXPERIMENT=false/);
  assert.match(
    rootEnvironment,
    /^H_MINESWEEPER_DUEL_EXPERIMENT=false$/m,
  );
  assert.match(rootEnvironment, /^VITE_DUEL_EXPERIMENT=false$/m);
  assert.match(
    serverEnvironment,
    /^H_MINESWEEPER_DUEL_EXPERIMENT=false$/m,
  );
  assert.match(
    webBuildConfig,
    /import\.meta\.env\.VITE_DUEL_EXPERIMENT === "true"/,
  );

  const rootScripts = JSON.parse(rootPackage).scripts;
  const serverScripts = JSON.parse(serverPackage).scripts;
  assert.doesNotMatch(
    serverScripts.dev,
    /H_MINESWEEPER_DUEL_EXPERIMENT=true/,
  );
  assert.match(
    rootScripts["dev:duel"],
    /H_MINESWEEPER_DUEL_EXPERIMENT=true/,
  );
  assert.match(rootScripts["dev:duel"], /VITE_DUEL_EXPERIMENT=true/);
});
