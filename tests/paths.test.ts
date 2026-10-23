import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertInside,
  PathPolicyError,
  resolveWorkspacePath,
} from "../src/paths.js";

test("workspace path policy accepts in-workspace paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentoonz-mcp-paths-"));
  await mkdir(join(root, "scenes"));
  await writeFile(join(root, "scenes", "shot.tnz"), "<tnz />");

  const resolved = resolveWorkspacePath(root, "scenes/shot.tnz", {
    mustExist: true,
  });
  assert.equal(resolved, join(root, "scenes", "shot.tnz"));
  assert.doesNotThrow(() => assertInside(root, resolved));
});

test("workspace path policy rejects traversal and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentoonz-mcp-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "opentoonz-mcp-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "escape"));

  assert.throws(
    () => resolveWorkspacePath(root, "../secret.txt"),
    PathPolicyError,
  );
  assert.throws(
    () => resolveWorkspacePath(root, "escape/secret.txt", { mustExist: true }),
    PathPolicyError,
  );
});
