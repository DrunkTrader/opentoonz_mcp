import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveWorkspacePath } from "./paths.js";

export interface McpConfig {
  workspaceRoot: string;
  opentoonzRoot?: string;
  buildDirectory?: string;
  tcomposerPath?: string;
  tconverterPath?: string;
  artifactDirectory: string;
  runtimeHome: string;
  libraryPath?: string;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  maxScanEntries: number;
  maxMetadataBytes: number;
  maxInspectConcurrency: number;
}

function optionalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = resolve(value);
  return existsSync(candidate) ? realpathSync.native(candidate) : candidate;
}

function discoverWorkspace(cwd: string): string {
  const explicit = process.env.OPENTOONZ_WORKSPACE;
  if (explicit) return resolve(explicit);

  const siblingOpenToonz = join(dirname(cwd), "opentoonz");
  if (basename(cwd) === "opentoonz_mcp" && existsSync(siblingOpenToonz)) {
    return realpathSync.native(siblingOpenToonz);
  }

  return resolve(cwd);
}

export function loadConfig(cwd = process.cwd()): McpConfig {
  const workspaceCandidate = discoverWorkspace(cwd);
  const workspaceRoot = existsSync(workspaceCandidate)
    ? realpathSync.native(workspaceCandidate)
    : workspaceCandidate;
  const buildDirectory = optionalPath(
    process.env.OPENTOONZ_BUILD_DIR ?? join(workspaceRoot, "toonz", "build"),
  );
  const opentoonzRoot = optionalPath(
    process.env.OPENTOONZ_ROOT ?? workspaceRoot,
  );
  const artifactDirectoryInput =
    process.env.OPENTOONZ_ARTIFACT_DIR ?? ".mcp-artifacts";
  const artifactDirectory = resolveWorkspacePath(
    workspaceRoot,
    artifactDirectoryInput,
    {
      allowDirectory: true,
    },
  );
  const runtimeHome = resolveWorkspacePath(
    workspaceRoot,
    process.env.OPENTOONZ_RUNTIME_HOME ??
      join(relativeArtifactPath(workspaceRoot, artifactDirectory), ".runtime"),
    { allowDirectory: true },
  );
  const libraryPath = optionalPath(
    process.env.OPENTOONZ_LIBRARY_PATH ??
      (buildDirectory ? join(buildDirectory, "lib", "opentoonz") : undefined),
  );
  const tcomposerPath = optionalPath(process.env.OPENTOONZ_TCOMPOSER);
  const tconverterPath = optionalPath(process.env.OPENTOONZ_TCONVERTER);

  return {
    workspaceRoot,
    ...(opentoonzRoot ? { opentoonzRoot } : {}),
    ...(buildDirectory ? { buildDirectory } : {}),
    ...(tcomposerPath ? { tcomposerPath } : {}),
    ...(tconverterPath ? { tconverterPath } : {}),
    artifactDirectory,
    runtimeHome,
    ...(libraryPath ? { libraryPath } : {}),
    defaultTimeoutMs: parsePositiveInt(
      process.env.OPENTOONZ_MCP_TIMEOUT_MS,
      120_000,
    ),
    maxOutputBytes: parsePositiveInt(
      process.env.OPENTOONZ_MCP_MAX_OUTPUT_BYTES,
      2_000_000,
    ),
    maxScanEntries: parsePositiveInt(
      process.env.OPENTOONZ_MCP_MAX_SCAN_ENTRIES,
      10_000,
    ),
    maxMetadataBytes: parsePositiveInt(
      process.env.OPENTOONZ_MCP_MAX_METADATA_BYTES,
      32_000_000,
    ),
    maxInspectConcurrency: parsePositiveInt(
      process.env.OPENTOONZ_MCP_MAX_INSPECT_CONCURRENCY,
      4,
    ),
  };
}

function relativeArtifactPath(
  workspaceRoot: string,
  artifactDirectory: string,
): string {
  const path = relative(workspaceRoot, artifactDirectory);
  return path || ".";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
