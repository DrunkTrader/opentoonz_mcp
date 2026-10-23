import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { McpConfig } from "../src/config.js";
import { WorkspaceService } from "../src/workspace.js";

async function fixture(): Promise<{ root: string; config: McpConfig }> {
  const root = await mkdtemp(join(tmpdir(), "opentoonz-mcp-workspace-"));
  await Promise.all([
    mkdir(join(root, "project", "scenes"), { recursive: true }),
    mkdir(join(root, "project", "drawings"), { recursive: true }),
    mkdir(join(root, "project", "outputs"), { recursive: true }),
  ]);
  await writeFile(
    join(root, "project", "project_otprj.xml"),
    [
      "<project>",
      "  <version>70 1</version>",
      "  <folders>",
      '    <folder name="scenes" path="scenes" />',
      '    <folder name="drawings" path="drawings" />',
      '    <folder name="outputs" path="outputs" />',
      "  </folders>",
      "</project>",
    ].join("\n"),
  );
  await writeFile(
    join(root, "project", "scenes", "scenes.xml"),
    '<parentProject type="projectFolder">..</parentProject>',
  );
  await writeFile(
    join(root, "project", "scenes", "shot.tnz"),
    [
      '<tnz version="71.1" framecount="24">',
      "  <levelSet>",
      "    <level><path>+drawings/char..tif</path></level>",
      "    <level><path>+drawings/missing.pli</path></level>",
      "  </levelSet>",
      "</tnz>",
    ].join("\n"),
  );
  await writeFile(join(root, "project", "drawings", "char.0001.tif"), "frame");
  const config: McpConfig = {
    workspaceRoot: root,
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

test("workspace service discovers projects and resolves scene aliases", async () => {
  const { config } = await fixture();
  const service = new WorkspaceService(config);

  const projects = await service.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "project");
  assert.equal(
    projects[0]?.folders
      .find((folder) => folder.name === "drawings")
      ?.absolutePath?.endsWith("/drawings"),
    true,
  );

  const scene = await service.inspectScene("project/scenes/shot.tnz");
  assert.equal(scene.frameCount, 24);
  assert.equal(scene.formatVersion, "71.1");
  assert.equal(scene.project?.name, "project");
  assert.equal(scene.references.length, 2);
  assert.equal(scene.references[0]?.exists, true);
  assert.equal(scene.references[1]?.exists, false);
});

test("workspace service reports missing resources without mutating the scene", async () => {
  const { config } = await fixture();
  const service = new WorkspaceService(config);
  const result = await service.validateSceneResources(
    "project/scenes/shot.tnz",
  );

  assert.equal(result.valid, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.external.length, 0);
  assert.equal(result.scene.frameCount, 24);
});

test("workspace service rejects scene references through an external symlink", async () => {
  const { root, config } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "opentoonz-mcp-external-"));
  await writeFile(join(outside, "secret.0001.tif"), "secret");
  await symlink(outside, join(root, "project", "drawings", "external"));
  await writeFile(
    join(root, "project", "scenes", "external-shot.tnz"),
    [
      '<tnz version="71.1" framecount="1">',
      "  <levelSet>",
      "    <level><path>+drawings/external/secret..tif</path></level>",
      "  </levelSet>",
      "</tnz>",
    ].join("\n"),
  );

  const service = new WorkspaceService(config);
  const scene = await service.inspectScene("project/scenes/external-shot.tnz");
  assert.equal(scene.references[0]?.insideWorkspace, false);
  assert.equal(scene.references[0]?.exists, false);
});

test("workspace service resolves scene-dependent project folders", async () => {
  const { root, config } = await fixture();
  await writeFile(
    join(root, "project", "project_otprj.xml"),
    [
      "<project>",
      "  <version>70 1</version>",
      "  <folders>",
      '    <folder name="scenes" path="scenes" />',
      '    <folder name="drawings" path="drawings/$scenepath" />',
      "  </folders>",
      "</project>",
    ].join("\n"),
  );
  await mkdir(join(root, "project", "scenes", "episode"), {
    recursive: true,
  });
  await mkdir(join(root, "project", "drawings", "episode", "shot"), {
    recursive: true,
  });
  await writeFile(
    join(root, "project", "scenes", "episode", "shot.tnz"),
    '<tnz version="71.1" framecount="1"><levelSet><level><path>+drawings/char..tif</path></level></levelSet></tnz>',
  );
  await writeFile(
    join(root, "project", "drawings", "episode", "shot", "char.0001.tif"),
    "frame",
  );

  const service = new WorkspaceService(config);
  const scene = await service.inspectScene("project/scenes/episode/shot.tnz");
  assert.equal(scene.references[0]?.exists, true);
  assert.equal(
    scene.references[0]?.resolvedPath,
    "project/drawings/episode/shot/char..tif",
  );
});

test("workspace service ignores external project descriptors reached through scenes.xml symlinks", async () => {
  const { root, config } = await fixture();
  const outside = await mkdtemp(
    join(tmpdir(), "opentoonz-mcp-external-project-"),
  );
  await writeFile(
    join(outside, "outside_otprj.xml"),
    '<project><version>99 9</version><folders><folder name="scenes" path="scenes" /></folders></project>',
  );
  await mkdir(join(root, "isolated", "scenes"), { recursive: true });
  await symlink(outside, join(root, "isolated", "scenes", "external"));
  await writeFile(
    join(root, "isolated", "scenes", "scenes.xml"),
    '<parentProject type="projectFolder">external</parentProject>',
  );
  await writeFile(
    join(root, "isolated", "scenes", "shot.tnz"),
    '<tnz version="71.1" framecount="1" />',
  );

  const service = new WorkspaceService(config);
  const scene = await service.inspectScene("isolated/scenes/shot.tnz");
  assert.equal(scene.project, undefined);
});
