import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { McpConfig } from "./config.js";
import { OpenToonzRunner } from "./runner.js";
import {
  assertInside,
  relativeWorkspacePath,
  resolveWorkspacePath,
} from "./paths.js";
import { WorkspaceService } from "./workspace.js";

export function createServer(config: McpConfig): McpServer {
  const workspace = new WorkspaceService(config);
  const runner = new OpenToonzRunner(config, workspace);
  const server = new McpServer({
    name: "opentoonz-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "workspace_manifest",
    {
      title: "Inspect OpenToonz workspace",
      description:
        "Return a live manifest of the configured workspace, discovered projects/scenes/levels, runtime paths, and available OpenToonz command-line capabilities.",
    },
    async () => safeTool(() => workspace.getManifest()),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List OpenToonz projects",
      description:
        "Discover OpenToonz project descriptors inside the workspace. Results are read-only and include project folders and parser warnings.",
      inputSchema: z.object({
        limit: z.number().int().positive().max(1000).optional(),
      }),
    },
    async ({ limit }) =>
      safeTool(async () => {
        const projects = await workspace.listProjects();
        return { projects: limit ? projects.slice(0, limit) : projects };
      }),
  );

  server.registerTool(
    "inspect_project",
    {
      title: "Inspect an OpenToonz project",
      description:
        "Parse one OpenToonz project descriptor and report its version, logical folder aliases, resolved in-workspace paths, and warnings.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .min(1)
          .describe("Workspace-relative or absolute project descriptor path"),
      }),
    },
    async ({ projectPath }) =>
      safeTool(() => workspace.inspectProject(projectPath)),
  );

  server.registerTool(
    "list_scenes",
    {
      title: "List OpenToonz scenes",
      description:
        "Discover .tnz and legacy .tab scenes. Optionally scope results to a project directory or descriptor.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .min(1)
          .optional()
          .describe("Optional project descriptor or project directory"),
        limit: z.number().int().positive().max(5000).optional(),
      }),
    },
    async ({ projectPath, limit }) =>
      safeTool(async () => {
        const scenes = await workspace.listScenes(projectPath);
        return { scenes: limit ? scenes.slice(0, limit) : scenes };
      }),
  );

  server.registerTool(
    "inspect_scene",
    {
      title: "Inspect an OpenToonz scene",
      description:
        "Read scene header metadata and extract serialized level/scanned-path references without loading or mutating scene resources.",
      inputSchema: z.object({
        scenePath: z
          .string()
          .min(1)
          .describe("Workspace-relative or absolute .tnz/.tab path"),
      }),
    },
    async ({ scenePath }) => safeTool(() => workspace.inspectScene(scenePath)),
  );

  server.registerTool(
    "validate_scene_resources",
    {
      title: "Validate scene resources",
      description:
        "Resolve scene path aliases and report missing or workspace-external level and scanned-image references. This is read-only.",
      inputSchema: z.object({
        scenePath: z.string().min(1),
      }),
    },
    async ({ scenePath }) =>
      safeTool(() => workspace.validateSceneResources(scenePath)),
  );

  server.registerTool(
    "list_level_files",
    {
      title: "List OpenToonz level files",
      description:
        "List recognized OpenToonz drawing, vector, raster, palette-adjacent, and image level files under an optional workspace-relative directory.",
      inputSchema: z.object({
        directory: z.string().min(1).optional(),
        limit: z.number().int().positive().max(10000).optional(),
      }),
    },
    async ({ directory, limit }) =>
      safeTool(async () => {
        const files = await workspace.listLevelFiles(directory);
        return { files: limit ? files.slice(0, limit) : files };
      }),
  );

  server.registerTool(
    "list_artifacts",
    {
      title: "List MCP artifacts",
      description:
        "List files produced by MCP render and conversion operations in the configured artifact directory.",
    },
    async () =>
      safeTool(async () => ({ artifacts: await workspace.listArtifacts() })),
  );

  server.registerTool(
    "render_preview",
    {
      title: "Render a preview frame",
      description:
        "Render one scene frame with tcomposer into a new .mcp-artifacts file. Existing files are never overwritten. Requires a built tcomposer executable.",
      inputSchema: z.object({
        scenePath: z.string().min(1),
        frame: z.number().int().positive().optional().default(1),
        outputPath: z.string().min(1).optional(),
        shrink: z.number().int().positive().optional(),
        threads: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      }),
    },
    async ({ scenePath, frame, outputPath, shrink, threads, timeoutMs }) =>
      safeTool(async () => {
        const output =
          outputPath ?? defaultArtifactPath(config, "preview", ".tif");
        assertArtifactPath(config, output);
        return runner.renderScene({
          scene: scenePath,
          output,
          frame,
          ...(shrink !== undefined ? { shrink } : {}),
          ...(threads !== undefined ? { threads } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
      }),
  );

  server.registerTool(
    "render_scene",
    {
      title: "Render an OpenToonz scene",
      description:
        "Render an image sequence or output file with tcomposer. The destination must be new and inside the configured workspace; no arbitrary shell commands are exposed.",
      inputSchema: z.object({
        scenePath: z.string().min(1),
        outputPath: z.string().min(1),
        frame: z.number().int().positive().optional(),
        frameStart: z.number().int().positive().optional(),
        frameEnd: z.number().int().positive().optional(),
        step: z.number().int().positive().optional(),
        shrink: z.number().int().positive().optional(),
        threads: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      }),
    },
    async ({
      scenePath,
      outputPath,
      frame,
      frameStart,
      frameEnd,
      step,
      shrink,
      threads,
      timeoutMs,
    }) =>
      safeTool(() =>
        runner.renderScene({
          scene: scenePath,
          output: outputPath,
          ...(frame !== undefined ? { frame } : {}),
          ...(frameStart !== undefined ? { frameStart } : {}),
          ...(frameEnd !== undefined ? { frameEnd } : {}),
          ...(step !== undefined ? { step } : {}),
          ...(shrink !== undefined ? { shrink } : {}),
          ...(threads !== undefined ? { threads } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      ),
  );

  server.registerTool(
    "convert_level",
    {
      title: "Convert an OpenToonz level",
      description:
        "Convert a level with tconverter into a new destination. Existing files are refused to avoid interactive overwrite prompts and accidental data loss.",
      inputSchema: z.object({
        sourcePath: z.string().min(1),
        destinationPath: z.string().min(1),
        frameStart: z.number().int().positive().optional(),
        frameEnd: z.number().int().positive().optional(),
        width: z.number().int().positive().optional(),
        scenePath: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
      }),
    },
    async ({
      sourcePath,
      destinationPath,
      frameStart,
      frameEnd,
      width,
      scenePath,
      timeoutMs,
    }) =>
      safeTool(() =>
        runner.convertLevel({
          source: sourcePath,
          destination: destinationPath,
          ...(frameStart !== undefined ? { frameStart } : {}),
          ...(frameEnd !== undefined ? { frameEnd } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(scenePath !== undefined ? { scene: scenePath } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      ),
  );

  server.registerResource(
    "workspace-manifest",
    "opentoonz://workspace/manifest",
    {
      title: "OpenToonz workspace manifest",
      description: "Live JSON manifest for the configured OpenToonz workspace.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await workspace.getManifest(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "scene-summary",
    new ResourceTemplate("opentoonz://scene/{+path}", { list: undefined }),
    {
      title: "OpenToonz scene summary",
      description:
        "Read-only scene metadata and serialized resource references.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const scenePath = decodeResourcePath(String(variables.path ?? ""));
      const scene = await workspace.inspectScene(scenePath);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(scene, null, 2),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "review-scene-health",
    {
      title: "Review OpenToonz scene health",
      description:
        "Prepare a focused prompt for checking scene metadata and missing resources.",
      argsSchema: z.object({
        scenePath: z.string().min(1),
      }),
    },
    async ({ scenePath }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Review the OpenToonz scene at ${scenePath}.`,
              "First call inspect_scene, then validate_scene_resources.",
              "Summarize frame count, project association, referenced levels, missing resources, and any path-sandbox warnings.",
              "Do not modify files unless the operator explicitly asks for a separate write-capable workflow.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

async function safeTool<T>(operation: () => Promise<T>): Promise<{
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}> {
  try {
    const value = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

function defaultArtifactPath(
  config: McpConfig,
  prefix: string,
  extension: string,
): string {
  const filename = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}${extension}`;
  return relativeWorkspacePath(
    config.workspaceRoot,
    join(config.artifactDirectory, filename),
  );
}

function assertArtifactPath(config: McpConfig, output: string): void {
  const resolvedOutput = resolveWorkspacePath(config.workspaceRoot, output);
  assertInside(config.artifactDirectory, resolvedOutput);
}

function decodeResourcePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(
      "The scene resource URI contains malformed percent-encoding",
    );
  }
}
