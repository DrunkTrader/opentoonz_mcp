export interface ProjectFolder {
  name: string;
  path: string;
  useScenePath: boolean;
  absolutePath?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  descriptorPath: string;
  projectFolder: string;
  folders: ProjectFolder[];
  version?: string;
  parseWarnings: string[];
}

export interface SceneReference {
  rawPath: string;
  kind: "path" | "scannedPath";
  resolvedPath?: string;
  exists: boolean;
  insideWorkspace: boolean;
}

export interface SceneSummary {
  id: string;
  name: string;
  path: string;
  extension: string;
  bytes: number;
  modifiedAt: string;
  frameCount?: number;
  formatVersion?: string;
  project?: ProjectSummary;
  references: SceneReference[];
  parseWarnings: string[];
}

export interface ArtifactInfo {
  path: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
}

export interface CommandResult {
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkspaceManifest {
  workspaceRoot: string;
  opentoonzRoot?: string;
  buildDirectory?: string;
  artifactDirectory: string;
  capabilities: {
    tcomposer: boolean;
    tconverter: boolean;
  };
  counts: {
    projects: number;
    scenes: number;
    levels: number;
  };
  generatedAt: string;
}
