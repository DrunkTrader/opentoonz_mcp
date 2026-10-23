import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { McpConfig } from "../src/config.js";
import { UserInputError } from "../src/errors.js";
import { OpenToonzRunner } from "../src/runner.js";
import { WorkspaceService } from "../src/workspace.js";

async function fixture(): Promise<{ root: string; config: McpConfig }> {
  const root = await mkdtemp(join(tmpdir(), "opentoonz-mcp-runner-"));
  const bin = join(root, "toonz", "build", "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "scene"), { recursive: true });
  await writeFile(join(root, "scene", "shot.tnz"), '<tnz framecount="1" />');
  await writeFile(
    join(bin, "tcomposer"),
    [
      "#!/bin/sh",
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "-o" ]; then out=$2; shift 2; else shift; fi',
      "done",
      'mkdir -p "$(dirname "$out")"',
      'stem="${out%.*}"',
      'ext="${out##*.}"',
      "printf 'rendered' > \"$stem.0001.$ext\"",
    ].join("\n"),
  );
  await writeFile(
    join(bin, "tconverter"),
    ["#!/bin/sh", "printf 'converted' > \"$2\""].join("\n"),
  );
  await chmod(join(bin, "tcomposer"), 0o755);
  await chmod(join(bin, "tconverter"), 0o755);
  const config: McpConfig = {
    workspaceRoot: root,
    buildDirectory: join(root, "toonz", "build"),
    artifactDirectory: join(root, ".mcp-artifacts"),
    runtimeHome: join(root, ".mcp-artifacts", ".runtime"),
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 10_000,
    maxScanEntries: 100,
    maxMetadataBytes: 1_000_000,
    maxInspectConcurrency: 2,
  };
  return { root, config };
}

test("runner collects rendered sequence artifacts", async () => {
  const { root, config } = await fixture();
  const workspace = new WorkspaceService(config);
  const runner = new OpenToonzRunner(config, workspace);
  const result = await runner.renderScene({
    scene: "scene/shot.tnz",
    output: ".mcp-artifacts/preview.tif",
    frame: 1,
  });

  assert.equal(result.result.exitCode, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(
    result.artifacts[0]?.relativePath,
    ".mcp-artifacts/preview.0001.tif",
  );
  assert.equal(result.artifacts[0]?.path.startsWith(root), true);
});

test("runner rejects an existing OpenToonz sequence family", async () => {
  const { config } = await fixture();
  await mkdir(join(config.workspaceRoot, ".mcp-artifacts"), {
    recursive: true,
  });
  await writeFile(
    join(config.workspaceRoot, ".mcp-artifacts", "preview.0001.tif"),
    "old",
  );
  const workspace = new WorkspaceService(config);
  const runner = new OpenToonzRunner(config, workspace);

  await assert.rejects(
    () =>
      runner.renderScene({
        scene: "scene/shot.tnz",
        output: ".mcp-artifacts/preview.tif",
      }),
    UserInputError,
  );
});

test("runner accepts an existing OpenToonz sequence as a conversion source", async () => {
  const { root, config } = await fixture();
  await mkdir(join(root, "levels"), { recursive: true });
  await writeFile(join(root, "levels", "char.0001.tif"), "frame");
  const workspace = new WorkspaceService(config);
  const runner = new OpenToonzRunner(config, workspace);
  const result = await runner.convertLevel({
    source: "levels/char..tif",
    destination: ".mcp-artifacts/char.png",
  });

  assert.equal(result.result.exitCode, 0);
  assert.equal(result.artifacts[0]?.relativePath, ".mcp-artifacts/char.png");
});
