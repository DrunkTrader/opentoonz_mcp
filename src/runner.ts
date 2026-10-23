import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import type { McpConfig } from "./config.js";
import { OperationError, UserInputError } from "./errors.js";
import {
  ensureDirectoryInside,
  relativeWorkspacePath,
  resolveWorkspacePath,
} from "./paths.js";
import type { ArtifactInfo, CommandResult } from "./types.js";
import { WorkspaceService } from "./workspace.js";

export interface RenderOptions {
  scene: string;
  output: string;
  frame?: number;
  frameStart?: number;
  frameEnd?: number;
  step?: number;
  shrink?: number;
  threads?: number;
  timeoutMs?: number;
}

export interface ConvertOptions {
  source: string;
  destination: string;
  frameStart?: number;
  frameEnd?: number;
  width?: number;
  scene?: string;
  timeoutMs?: number;
}

export class OpenToonzRunner {
  private readonly activeOutputFamilies = new Set<string>();

  constructor(
    private readonly config: McpConfig,
    private readonly workspace: WorkspaceService,
  ) {}

  async renderScene(options: RenderOptions): Promise<{
    result: CommandResult;
    artifacts: ArtifactInfo[];
  }> {
    const scene = resolveWorkspacePath(
      this.config.workspaceRoot,
      options.scene,
      {
        mustExist: true,
      },
    );
    validateRenderOptions(options);
    const resourceValidation = await this.workspace.validateSceneResources(
      options.scene,
    );
    if (!resourceValidation.valid) {
      throw new OperationError(
        "Refusing to render a scene with missing, unresolved, or external resources. Validate and repair the scene first.",
      );
    }
    const output = this.prepareOutput(options.output);
    const args = [scene, "-o", output];
    if (options.frame !== undefined) {
      args.push("-frame", String(options.frame));
    } else if (
      options.frameStart !== undefined ||
      options.frameEnd !== undefined
    ) {
      if (options.frameStart === undefined || options.frameEnd === undefined) {
        throw new UserInputError(
          "frameStart and frameEnd must be provided together",
        );
      }
      args.push("-range", String(options.frameStart), String(options.frameEnd));
    }
    if (options.step !== undefined) args.push("-step", String(options.step));
    if (options.shrink !== undefined)
      args.push("-shrink", String(options.shrink));
    if (options.threads !== undefined)
      args.push("-nthreads", String(options.threads));

    const startedAt = Date.now();
    try {
      const result = await this.run("tcomposer", args, options.timeoutMs);
      if (result.exitCode !== 0 || result.timedOut) {
        throw new OperationError(formatCommandFailure("tcomposer", result));
      }
      return {
        result,
        artifacts: await this.collectArtifacts(output, startedAt),
      };
    } finally {
      this.activeOutputFamilies.delete(outputFamilyKey(output));
    }
  }

  async convertLevel(options: ConvertOptions): Promise<{
    result: CommandResult;
    artifacts: ArtifactInfo[];
  }> {
    const source = this.resolveLevelInput(options.source);
    validateRange(options.frameStart, options.frameEnd);
    const scene = options.scene
      ? resolveWorkspacePath(this.config.workspaceRoot, options.scene, {
          mustExist: true,
        })
      : undefined;
    const destination = this.prepareOutput(options.destination);
    const args = [source, destination];
    if (options.width !== undefined) args.push("-w", String(options.width));
    if (scene) args.push("-s", scene);
    if (options.frameStart !== undefined || options.frameEnd !== undefined) {
      if (options.frameStart === undefined || options.frameEnd === undefined) {
        throw new UserInputError(
          "frameStart and frameEnd must be provided together",
        );
      }
      args.push("-range", String(options.frameStart), String(options.frameEnd));
    }

    const startedAt = Date.now();
    try {
      const result = await this.run("tconverter", args, options.timeoutMs);
      if (result.exitCode !== 0 || result.timedOut) {
        throw new OperationError(formatCommandFailure("tconverter", result));
      }
      return {
        result,
        artifacts: await this.collectArtifacts(destination, startedAt),
      };
    } finally {
      this.activeOutputFamilies.delete(outputFamilyKey(destination));
    }
  }

  private prepareOutput(input: string): string {
    const output = resolveWorkspacePath(this.config.workspaceRoot, input);
    if (
      this.activeOutputFamilies.has(outputFamilyKey(output)) ||
      outputFamilyExists(output)
    ) {
      throw new UserInputError(
        `Refusing to overwrite an existing OpenToonz output family. Choose a new path: ${input}`,
      );
    }
    ensureDirectoryInside(this.config.workspaceRoot, dirname(output));
    this.activeOutputFamilies.add(outputFamilyKey(output));
    return output;
  }

  private async run(
    name: "tcomposer" | "tconverter",
    args: string[],
    timeoutMs = this.config.defaultTimeoutMs,
  ): Promise<CommandResult> {
    const binary = this.workspace.findBinary(name);
    if (!binary) {
      throw new OperationError(
        `${name} was not found. Set OPENTOONZ_BUILD_DIR or OPENTOONZ_${name.toUpperCase()} to a built executable.`,
      );
    }
    const startedAt = Date.now();
    const environment: NodeJS.ProcessEnv = {
      PATH:
        process.platform === "win32"
          ? "C:\\Windows\\System32"
          : "/usr/bin:/bin",
      HOME: this.config.runtimeHome,
      XDG_CONFIG_HOME: join(this.config.runtimeHome, ".config"),
      XDG_CACHE_HOME: join(this.config.runtimeHome, ".cache"),
      QT_QPA_PLATFORM: "offscreen",
      ...(this.config.opentoonzRoot
        ? { TOONZROOT: this.config.opentoonzRoot }
        : {}),
      ...(this.config.libraryPath
        ? { LD_LIBRARY_PATH: this.config.libraryPath }
        : {}),
    };
    ensureDirectoryInside(this.config.workspaceRoot, this.config.runtimeHome);
    ensureDirectoryInside(
      this.config.workspaceRoot,
      environment.XDG_CONFIG_HOME as string,
    );
    ensureDirectoryInside(
      this.config.workspaceRoot,
      environment.XDG_CACHE_HOME as string,
    );
    this.writeSystemVarConfig();
    return new Promise((resolvePromise, reject) => {
      const child = spawn(binary, args, {
        cwd: this.config.workspaceRoot,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "stdout")
          stdout = boundedAppend(stdout, text, this.config.maxOutputBytes);
        else stderr = boundedAppend(stderr, text, this.config.maxOutputBytes);
      };

      child.stdout.on("data", (chunk) => append("stdout", chunk));
      child.stderr.on("data", (chunk) => append("stderr", chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });

      const timer = setTimeout(
        () => {
          timedOut = true;
          killProcessTree(child.pid, "SIGTERM");
          setTimeout(
            () => killProcessTree(child.pid, "SIGKILL"),
            2_000,
          ).unref();
        },
        Math.max(1_000, timeoutMs),
      );
      timer.unref();

      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolvePromise({
          command: [binary, ...args],
          cwd: this.config.workspaceRoot,
          exitCode,
          ...(signal ? { signal } : {}),
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  private async collectArtifacts(
    output: string,
    startedAt: number,
  ): Promise<ArtifactInfo[]> {
    const parent = dirname(output);
    const expectedName = basename(output);
    const sequencePrefix = levelStem(expectedName);
    if (!existsSync(parent)) return [];
    const artifacts: ArtifactInfo[] = [];
    for (const entry of readdirSync(parent)) {
      const path = join(parent, entry);
      let linkStats;
      try {
        linkStats = lstatSync(path);
      } catch {
        continue;
      }
      if (!linkStats.isFile()) continue;
      let fileStats;
      try {
        fileStats = statSync(path);
      } catch {
        continue;
      }
      if (fileStats.mtimeMs + 1 < startedAt) continue;
      if (
        entry !== expectedName &&
        !entry.startsWith(`${sequencePrefix}.`) &&
        !entry.startsWith(`${sequencePrefix}..`)
      )
        continue;
      artifacts.push({
        path,
        relativePath: relativeWorkspacePath(this.config.workspaceRoot, path),
        bytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
    return artifacts.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
  }

  private resolveLevelInput(input: string): string {
    try {
      return resolveWorkspacePath(this.config.workspaceRoot, input, {
        mustExist: true,
      });
    } catch (error) {
      const candidate = resolveWorkspacePath(this.config.workspaceRoot, input);
      if (
        !isLevelSequencePath(candidate) ||
        !safeSequenceExists(this.config.workspaceRoot, candidate)
      ) {
        throw error;
      }
      return candidate;
    }
  }

  private writeSystemVarConfig(): void {
    if (!this.config.opentoonzRoot) return;
    const configDirectory = ensureDirectoryInside(
      this.config.workspaceRoot,
      join(this.config.runtimeHome, ".config", "OpenToonz"),
    );
    writeFileSync(
      join(configDirectory, "SystemVar.ini"),
      `[General]\nTOONZROOT=${this.config.opentoonzRoot}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

function outputFamilyExists(output: string): boolean {
  if (existsSync(output)) return true;
  const parent = dirname(output);
  if (!existsSync(parent)) return false;
  const stem = levelStem(basename(output));
  const extension = basename(output).split(".").pop() ?? "";
  try {
    return readdirSync(parent).some((entry) => {
      if (entry === basename(output)) return true;
      if (!entry.startsWith(`${stem}.`)) return false;
      return (
        extension.length === 0 ||
        entry.endsWith(`.${extension}`) ||
        entry.endsWith(".tpl")
      );
    });
  } catch {
    return false;
  }
}

function levelStem(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const sequenceMarker = withoutExtension.indexOf("..");
  return sequenceMarker === -1
    ? withoutExtension
    : withoutExtension.slice(0, sequenceMarker);
}

function outputFamilyKey(output: string): string {
  const key = join(dirname(output), levelStem(basename(output)));
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function isLevelSequencePath(path: string): boolean {
  return basename(path).includes("..");
}

function safeSequenceExists(
  workspaceRoot: string,
  sequencePath: string,
): boolean {
  const parent = dirname(sequencePath);
  if (!existsSync(parent)) return false;
  const name = basename(sequencePath);
  const marker = name.indexOf("..");
  const prefix = name.slice(0, marker);
  const suffix = name.slice(marker + 2);
  try {
    return readdirSync(parent).some((entry) => {
      if (!entry.startsWith(`${prefix}.`) || !entry.endsWith(`.${suffix}`)) {
        return false;
      }
      try {
        const canonical = resolveWorkspacePath(
          workspaceRoot,
          join(parent, entry),
          { mustExist: true },
        );
        return lstatSync(canonical).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function boundedAppend(
  current: string,
  addition: string,
  maxBytes: number,
): string {
  const next = current + addition;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const suffix = "\n[output truncated by opentoonz-mcp]\n";
  const bytes = Buffer.from(next, "utf8");
  return Buffer.concat([
    bytes.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))),
    Buffer.from(suffix),
  ]).toString("utf8");
}

function formatCommandFailure(name: string, result: CommandResult): string {
  const details = [
    `${name} failed with exit code ${result.exitCode ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}.`,
    result.timedOut ? "The operation timed out." : "",
    result.stderr.trim() || result.stdout.trim(),
  ].filter(Boolean);
  return details.join(" ");
}

function validateRenderOptions(options: RenderOptions): void {
  if (
    options.frame !== undefined &&
    (options.frameStart !== undefined || options.frameEnd !== undefined)
  ) {
    throw new UserInputError(
      "Specify either frame or frameStart/frameEnd, not both",
    );
  }
  validateRange(options.frameStart, options.frameEnd);
}

function validateRange(
  frameStart: number | undefined,
  frameEnd: number | undefined,
): void {
  if ((frameStart === undefined) !== (frameEnd === undefined)) {
    throw new UserInputError(
      "frameStart and frameEnd must be provided together",
    );
  }
  if (
    frameStart !== undefined &&
    frameEnd !== undefined &&
    frameStart > frameEnd
  ) {
    throw new UserInputError("frameStart must not exceed frameEnd");
  }
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // The process may already have exited between timeout and termination.
  }
}
