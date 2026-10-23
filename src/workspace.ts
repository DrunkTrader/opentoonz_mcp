import { XMLParser } from "fast-xml-parser";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { McpConfig } from "./config.js";
import { OperationError, UserInputError } from "./errors.js";
import {
  assertInside,
  relativeWorkspacePath,
  resolveWorkspacePath,
} from "./paths.js";
import type {
  ArtifactInfo,
  ProjectFolder,
  ProjectSummary,
  SceneReference,
  SceneSummary,
  WorkspaceManifest,
} from "./types.js";

const PROJECT_SUFFIXES = [
  "_otprj.xml",
  "_prj63ml.xml",
  "_prj6.xml",
  "_prj.xml",
  "tahomaproject.xml",
];

const LEVEL_EXTENSIONS = new Set([
  ".pli",
  ".svg",
  ".tlv",
  ".tzl",
  ".tzp",
  ".tzu",
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tif",
  ".tiff",
  ".tga",
  ".sgi",
  ".rgb",
  ".exr",
  ".psd",
  ".mesh",
  ".tzm",
]);

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".mcp-artifacts",
  "node_modules",
  "dist",
  "build",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  processEntities: false,
});

interface WalkResult {
  files: string[];
  truncated: boolean;
}

interface ParsedProject {
  summary: ProjectSummary;
  folderMap: Map<string, ProjectFolder>;
}

export class WorkspaceService {
  constructor(private readonly config: McpConfig) {}

  async getManifest(): Promise<WorkspaceManifest> {
    const [projects, scenes, levels] = await Promise.all([
      this.listProjects(),
      this.listScenes(),
      this.listLevelFiles(),
    ]);
    return {
      workspaceRoot: this.config.workspaceRoot,
      ...(this.config.opentoonzRoot
        ? { opentoonzRoot: this.config.opentoonzRoot }
        : {}),
      ...(this.config.buildDirectory
        ? { buildDirectory: this.config.buildDirectory }
        : {}),
      artifactDirectory: this.config.artifactDirectory,
      capabilities: {
        tcomposer: this.findBinary("tcomposer") !== undefined,
        tconverter: this.findBinary("tconverter") !== undefined,
      },
      counts: {
        projects: projects.length,
        scenes: scenes.length,
        levels: levels.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const result = await this.walkFiles((file) => isProjectDescriptor(file));
    const projects = await mapWithConcurrency(
      result.files,
      this.config.maxInspectConcurrency,
      (file) => this.parseProject(file),
    );
    return projects.map((project) => project.summary);
  }

  async listScenes(projectPath?: string): Promise<SceneSummary[]> {
    const result = await this.walkFiles((file) => {
      const extension = extname(file).toLowerCase();
      return extension === ".tnz" || extension === ".tab";
    });
    const normalizedProject = projectPath
      ? resolveWorkspacePath(this.config.workspaceRoot, projectPath, {
          mustExist: true,
          allowDirectory: true,
        })
      : undefined;
    const scenePaths = result.files.filter(
      (file) =>
        !normalizedProject || isSceneUnderProject(file, normalizedProject),
    );
    return mapWithConcurrency(
      scenePaths,
      this.config.maxInspectConcurrency,
      (file) => this.inspectScene(file),
    );
  }

  async inspectProject(input: string): Promise<ProjectSummary> {
    const path = resolveWorkspacePath(this.config.workspaceRoot, input, {
      mustExist: true,
    });
    if (!isProjectDescriptor(path)) {
      throw new UserInputError(`Not an OpenToonz project descriptor: ${input}`);
    }
    return (await this.parseProject(path)).summary;
  }

  async inspectScene(input: string): Promise<SceneSummary> {
    const path = resolveWorkspacePath(this.config.workspaceRoot, input, {
      mustExist: true,
    });
    const extension = extname(path).toLowerCase();
    if (extension !== ".tnz" && extension !== ".tab") {
      throw new UserInputError(`Not an OpenToonz scene file: ${input}`);
    }

    const fileStats = await stat(path);
    if (fileStats.size > this.config.maxMetadataBytes) {
      throw new OperationError(
        `Scene metadata file exceeds the configured limit of ${this.config.maxMetadataBytes} bytes: ${input}`,
      );
    }
    const raw = await readFile(path, "utf8");
    const parsedProject = await this.findProjectForScene(path);
    const parseWarnings: string[] = [];
    if (!parsedProject) {
      parseWarnings.push(
        "No project descriptor was found through scenes.xml or an ancestor directory; +folder aliases cannot be fully resolved.",
      );
    }

    const references = extractSceneReferences(raw).map((reference) =>
      this.resolveSceneReference(reference, path, parsedProject, parseWarnings),
    );
    const header = parseSceneHeader(raw);
    return {
      id: relativeWorkspacePath(this.config.workspaceRoot, path),
      name: basename(path, extension),
      path: relativeWorkspacePath(this.config.workspaceRoot, path),
      extension,
      bytes: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString(),
      ...(header.frameCount !== undefined
        ? { frameCount: header.frameCount }
        : {}),
      ...(header.formatVersion ? { formatVersion: header.formatVersion } : {}),
      ...(parsedProject ? { project: parsedProject.summary } : {}),
      references,
      parseWarnings: unique(parseWarnings),
    };
  }

  async validateSceneResources(input: string): Promise<{
    scene: SceneSummary;
    missing: SceneReference[];
    external: SceneReference[];
    valid: boolean;
  }> {
    const scene = await this.inspectScene(input);
    const missing = scene.references.filter(
      (reference) => reference.insideWorkspace && !reference.exists,
    );
    const external = scene.references.filter(
      (reference) => !reference.insideWorkspace,
    );
    return {
      scene,
      missing,
      external,
      valid: missing.length === 0 && external.length === 0,
    };
  }

  async listLevelFiles(directory?: string): Promise<string[]> {
    const root = directory
      ? resolveWorkspacePath(this.config.workspaceRoot, directory, {
          mustExist: true,
          allowDirectory: true,
        })
      : this.config.workspaceRoot;
    const result = await this.walkFiles(
      (file) => LEVEL_EXTENSIONS.has(extname(file).toLowerCase()),
      root,
    );
    return result.files.map((file) =>
      relativeWorkspacePath(this.config.workspaceRoot, file),
    );
  }

  async listArtifacts(): Promise<ArtifactInfo[]> {
    if (!existsSync(this.config.artifactDirectory)) return [];
    const artifactDirectory = resolveWorkspacePath(
      this.config.workspaceRoot,
      this.config.artifactDirectory,
      { mustExist: true, allowDirectory: true },
    );
    const result = await this.walkFiles(() => true, artifactDirectory);
    const artifacts: ArtifactInfo[] = [];
    for (const file of result.files) {
      const fileStats = await stat(file);
      artifacts.push({
        path: file,
        relativePath: relativeWorkspacePath(this.config.workspaceRoot, file),
        bytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
    return artifacts;
  }

  findBinary(name: "tcomposer" | "tconverter"): string | undefined {
    const configured =
      name === "tcomposer"
        ? this.config.tcomposerPath
        : this.config.tconverterPath;
    if (configured && isExecutableFile(configured)) return configured;
    if (!this.config.buildDirectory) return undefined;
    const candidate = join(this.config.buildDirectory, "bin", name);
    if (!isExecutableFile(candidate)) return undefined;
    try {
      const canonical = realpathSync.native(candidate);
      assertInside(this.config.buildDirectory, canonical);
      return canonical;
    } catch {
      return undefined;
    }
  }

  private async parseProject(path: string): Promise<ParsedProject> {
    const parseWarnings: string[] = [];
    let parsed: Record<string, unknown> = {};
    try {
      const fileStats = await stat(path);
      if (fileStats.size > this.config.maxMetadataBytes) {
        throw new OperationError(
          `Project descriptor exceeds the configured limit of ${this.config.maxMetadataBytes} bytes`,
        );
      }
      parsed = xmlParser.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      parseWarnings.push(
        `Project XML could not be parsed: ${errorMessage(error)}`,
      );
    }

    const projectNode = asRecord(parsed.project);
    const foldersNode = asRecord(projectNode?.folders);
    const rawFolders = toArray(foldersNode?.folder);
    const projectFolder = dirname(path);
    const folders: ProjectFolder[] = [];
    const folderMap = new Map<string, ProjectFolder>();
    for (const rawFolder of rawFolders) {
      const folder = asRecord(rawFolder);
      const name = stringValue(folder?.["@_name"]);
      const rawFolderPath = stringValue(folder?.["@_path"]);
      if (!name || !rawFolderPath) {
        parseWarnings.push(
          "A project folder entry was missing its name or path attribute.",
        );
        continue;
      }
      const unresolvedAbsolutePath = this.resolveProjectLogicalPath(
        rawFolderPath,
        projectFolder,
        name,
      );
      let absolutePath: string | undefined;
      if (unresolvedAbsolutePath) {
        try {
          absolutePath = resolveWorkspacePath(
            this.config.workspaceRoot,
            unresolvedAbsolutePath,
            {
              allowDirectory: true,
            },
          );
        } catch {
          parseWarnings.push(
            `Project folder is outside the configured workspace: ${name}`,
          );
        }
      }
      const item: ProjectFolder = {
        name,
        path: rawFolderPath,
        useScenePath: stringValue(folder?.["@_useScenePath"]) === "yes",
        ...(absolutePath ? { absolutePath } : {}),
      };
      folders.push(item);
      folderMap.set(name, item);
    }

    const version = textValue(projectNode?.version)
      ?.trim()
      .replace(/\s+/g, ".");
    const projectName = projectNameFromDescriptor(path);
    const summary: ProjectSummary = {
      id: relativeWorkspacePath(this.config.workspaceRoot, path),
      name: projectName,
      descriptorPath: relativeWorkspacePath(this.config.workspaceRoot, path),
      projectFolder: relativeWorkspacePath(
        this.config.workspaceRoot,
        projectFolder,
      ),
      folders,
      ...(version ? { version } : {}),
      parseWarnings: unique(parseWarnings),
    };
    return { summary, folderMap };
  }

  private async findProjectForScene(
    scenePath: string,
  ): Promise<ParsedProject | undefined> {
    let directory = dirname(scenePath);
    while (true) {
      const scenesDescriptor = join(directory, "scenes.xml");
      let canonicalScenesDescriptor: string | undefined;
      try {
        canonicalScenesDescriptor = resolveWorkspacePath(
          this.config.workspaceRoot,
          scenesDescriptor,
          { mustExist: true },
        );
      } catch {
        canonicalScenesDescriptor = undefined;
      }
      if (canonicalScenesDescriptor) {
        try {
          const descriptorStats = await stat(canonicalScenesDescriptor);
          if (descriptorStats.size > this.config.maxMetadataBytes) {
            throw new OperationError(
              `scenes.xml exceeds the configured limit of ${this.config.maxMetadataBytes} bytes`,
            );
          }
          const raw = await readFile(canonicalScenesDescriptor, "utf8");
          const match = raw.match(
            /<parentProject(?:\s+[^>]*)?>([\s\S]*?)<\/parentProject>/i,
          );
          const typeMatch = raw.match(
            /<parentProject\s+[^>]*type=["']([^"']+)["']/i,
          );
          const parentText = decodeXml(match?.[1] ?? "..").trim();
          const projectDirectory = resolve(directory, parentText || "..");
          const descriptor =
            await this.findDescriptorInDirectory(projectDirectory);
          if (descriptor) return this.parseProject(descriptor);
          if (typeMatch?.[1] === "projectFolder") {
            const ancestorDescriptor =
              await this.findDescriptorInDirectory(projectDirectory);
            if (ancestorDescriptor)
              return this.parseProject(ancestorDescriptor);
          }
        } catch {
          // Continue searching ancestors; the scene may still be standalone.
        }
      }

      const descriptor = await this.findDescriptorInDirectory(directory);
      if (descriptor) return this.parseProject(descriptor);
      const parent = dirname(directory);
      if (
        parent === directory ||
        !isInsideOrEqual(this.config.workspaceRoot, parent)
      )
        break;
      directory = parent;
    }
    return undefined;
  }

  private async findDescriptorInDirectory(
    directory: string,
  ): Promise<string | undefined> {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = resolveWorkspacePath(
        this.config.workspaceRoot,
        directory,
        { mustExist: true, allowDirectory: true },
      );
    } catch {
      return undefined;
    }
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    const descriptor = entries
      .filter((entry) => entry.isFile() && isProjectDescriptor(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    return descriptor ? join(canonicalDirectory, descriptor.name) : undefined;
  }

  private resolveSceneReference(
    reference: { rawPath: string; kind: "path" | "scannedPath" },
    scenePath: string,
    project: ParsedProject | undefined,
    parseWarnings: string[],
  ): SceneReference {
    const rawPath = reference.rawPath.trim();
    const resolved = this.resolveSceneLogicalPath(rawPath, scenePath, project);
    if (!resolved) {
      parseWarnings.push(`Could not resolve scene reference: ${rawPath}`);
      return { ...reference, exists: false, insideWorkspace: false };
    }
    let canonicalPath: string;
    try {
      canonicalPath = resolveWorkspacePath(this.config.workspaceRoot, resolved);
    } catch {
      return { ...reference, exists: false, insideWorkspace: false };
    }
    const sequenceStatus = sequenceFamilyStatus(
      this.config.workspaceRoot,
      canonicalPath,
    );
    if (sequenceStatus === "external") {
      return {
        ...reference,
        resolvedPath: relativeWorkspacePath(
          this.config.workspaceRoot,
          canonicalPath,
        ),
        exists: false,
        insideWorkspace: false,
      };
    }
    const insideWorkspace = true;
    const exists = sequenceStatus === "exists";
    return {
      ...reference,
      resolvedPath: relativeWorkspacePath(
        this.config.workspaceRoot,
        canonicalPath,
      ),
      exists,
      insideWorkspace,
    };
  }

  private resolveProjectLogicalPath(
    rawPath: string,
    projectFolder: string,
    projectName: string,
    aliasName?: string,
  ): string | undefined {
    if (/\$scene(?:path|name)?/i.test(rawPath)) return undefined;
    const expanded = rawPath
      .replace(/\\/g, "/")
      .replace(/\$project/g, projectName);
    if (expanded.startsWith("+")) {
      const slash = expanded.indexOf("/");
      const name = expanded.slice(1, slash === -1 ? undefined : slash);
      const tail = slash === -1 ? "" : expanded.slice(slash + 1);
      if (aliasName && name === aliasName) return resolve(projectFolder, tail);
      return undefined;
    }
    return resolve(projectFolder, expanded);
  }

  private resolveSceneLogicalPath(
    rawPath: string,
    scenePath: string,
    project: ParsedProject | undefined,
  ): string | undefined {
    const normalized = rawPath.replace(/\\/g, "/");
    const sceneDirectory = dirname(scenePath);
    const projectFolder = project
      ? resolve(this.config.workspaceRoot, project.summary.projectFolder)
      : undefined;
    const sceneRoot = project?.summary.folders.find(
      (folder) => folder.name === "scenes",
    )?.absolutePath;
    const sceneRelativeName =
      sceneRoot && isInsideOrEqual(sceneRoot, scenePath)
        ? relative(sceneRoot, scenePath).replace(extname(scenePath), "")
        : basename(scenePath, extname(scenePath));
    let expanded = normalized
      .replace(/\$project/g, project?.summary.name ?? "")
      .replace(/\$scenefolder/g, sceneDirectory)
      .replace(/\$scenepath/g, sceneRelativeName)
      .replace(/\$scenename/g, sceneRelativeName);

    if (expanded.startsWith("+")) {
      const slash = expanded.indexOf("/");
      const alias = expanded.slice(1, slash === -1 ? undefined : slash);
      const tail = slash === -1 ? "" : expanded.slice(slash + 1);
      const folder = project?.summary.folders.find(
        (item) => item.name === alias,
      );
      const folderPath = folder
        ? this.resolveSceneProjectFolder(folder, project, scenePath)
        : undefined;
      if (!folderPath) return undefined;
      expanded = join(folderPath, tail);
    } else if (!isAbsolute(expanded)) {
      expanded = resolve(projectFolder ?? sceneDirectory, expanded);
    }
    return resolve(expanded);
  }

  private resolveSceneProjectFolder(
    folder: ProjectFolder,
    project: ParsedProject | undefined,
    scenePath: string,
  ): string | undefined {
    if (!project) return folder.absolutePath;
    const projectFolder = resolve(
      this.config.workspaceRoot,
      project.summary.projectFolder,
    );
    const sceneRoot = project.summary.folders.find(
      (item) => item.name === "scenes",
    )?.absolutePath;
    const sceneRelativeName =
      sceneRoot && isInsideOrEqual(sceneRoot, scenePath)
        ? relative(sceneRoot, scenePath).replace(extname(scenePath), "")
        : basename(scenePath, extname(scenePath));
    const expanded = folder.path
      .replace(/\\/g, "/")
      .replace(/\$project/g, project.summary.name)
      .replace(/\$scenepath/g, sceneRelativeName)
      .replace(/\$scenename/g, sceneRelativeName);
    const candidate = expanded.startsWith("+")
      ? undefined
      : resolve(projectFolder, expanded);
    if (!candidate) return folder.absolutePath;
    try {
      return resolveWorkspacePath(this.config.workspaceRoot, candidate, {
        allowDirectory: true,
      });
    } catch {
      return undefined;
    }
  }

  private async walkFiles(
    predicate: (file: string) => boolean,
    root = this.config.workspaceRoot,
  ): Promise<WalkResult> {
    const files: string[] = [];
    const queue = [root];
    while (queue.length > 0 && files.length < this.config.maxScanEntries) {
      const current = queue.shift();
      if (!current) break;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          if (
            !SKIPPED_DIRECTORIES.has(entry.name) &&
            !entry.name.startsWith(".")
          ) {
            queue.push(fullPath);
          }
        } else if (entry.isFile() && predicate(fullPath)) {
          files.push(fullPath);
          if (files.length >= this.config.maxScanEntries) break;
        }
      }
    }
    files.sort();
    return { files, truncated: files.length >= this.config.maxScanEntries };
  }
}

export function isProjectDescriptor(file: string): boolean {
  const name = basename(file).toLowerCase();
  return PROJECT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function projectNameFromDescriptor(path: string): string {
  const name = basename(path);
  for (const suffix of PROJECT_SUFFIXES) {
    if (name.endsWith(suffix))
      return name.slice(0, -suffix.length) || basename(dirname(path));
  }
  return basename(dirname(path));
}

function isSceneUnderProject(scenePath: string, projectPath: string): boolean {
  const projectDirectory = lstatSync(projectPath).isDirectory()
    ? projectPath
    : dirname(projectPath);
  return isInsideOrEqual(projectDirectory, scenePath);
}

function extractSceneReferences(
  raw: string,
): Array<{ rawPath: string; kind: "path" | "scannedPath" }> {
  const references: Array<{ rawPath: string; kind: "path" | "scannedPath" }> =
    [];
  const levelSet =
    raw.match(/<levelSet\b[^>]*>([\s\S]*?)<\/levelSet>/i)?.[1] ?? "";
  const levelBlocks = [
    ...levelSet.matchAll(/<level\b[^>]*>([\s\S]*?)<\/level>/gi),
  ].map((match) => match[1] ?? "");
  const regions = levelBlocks.length > 0 ? levelBlocks : [levelSet];
  const pattern = /<(path|scannedPath)(?:\s[^>]*)?>([^<]*)<\/\1>/gi;
  for (const region of regions) {
    for (const match of region.matchAll(pattern)) {
      const kind =
        match[1]?.toLowerCase() === "scannedpath" ? "scannedPath" : "path";
      const rawPath = decodeXml(match[2] ?? "").trim();
      if (rawPath) references.push({ rawPath, kind });
    }
  }
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.rawPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseSceneHeader(raw: string): {
  frameCount?: number;
  formatVersion?: string;
} {
  const header = raw.match(/<(tnz|tab)\b([^>]*)>/i)?.[2] ?? "";
  const frameCount = header.match(/\bframecount=["'](\d+)["']/i)?.[1];
  const version = header.match(/\bversion=["']([^"']+)["']/i)?.[1];
  return {
    ...(frameCount !== undefined
      ? { frameCount: Number.parseInt(frameCount, 10) }
      : {}),
    ...(version ? { formatVersion: version } : {}),
  };
}

function sequenceFamilyStatus(
  workspaceRoot: string,
  path: string,
): "exists" | "missing" | "external" {
  if (existsSync(path)) return "exists";
  const parent = dirname(path);
  const name = basename(path);
  const marker = name.indexOf("..");
  if (marker === -1 || !existsSync(parent)) return "missing";
  const prefix = name.slice(0, marker);
  const suffix = name.slice(marker + 2);
  try {
    let found = false;
    for (const candidate of readdirSync(parent)) {
      if (
        !candidate.startsWith(`${prefix}.`) ||
        !candidate.endsWith(`.${suffix}`)
      ) {
        continue;
      }
      try {
        const canonical = resolveWorkspacePath(
          workspaceRoot,
          join(parent, candidate),
          { mustExist: true },
        );
        if (lstatSync(canonical).isFile()) found = true;
      } catch {
        return "external";
      }
    }
    return found ? "exists" : "missing";
  } catch {
    return "missing";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  const record = asRecord(value);
  return record ? stringValue(record["#text"]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  try {
    assertInside(root, candidate);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      () => worker(),
    ),
  );
  return results;
}
