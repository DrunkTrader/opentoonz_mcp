import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export function assertInside(root: string, candidate: string): void {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const relation = relative(rootResolved, candidateResolved);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new PathPolicyError(
      `Path escapes the configured workspace: ${candidateResolved}`,
    );
  }
}

function realpathNearestExisting(candidate: string): string {
  let current = candidate;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return candidate;
    suffix.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  const resolvedExisting = realpathSync.native(current);
  return suffix.reduce(
    (path, segment) => resolve(path, segment),
    resolvedExisting,
  );
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  input: string,
  options: { mustExist?: boolean; allowDirectory?: boolean } = {},
): string {
  if (!input || input.includes("\0")) {
    throw new PathPolicyError("A non-empty, NUL-free path is required");
  }

  const candidate = isAbsolute(input)
    ? resolve(input)
    : resolve(workspaceRoot, input);
  const checked = existsSync(candidate)
    ? realpathSync.native(candidate)
    : realpathNearestExisting(candidate);
  assertInside(workspaceRoot, checked);

  if (options.mustExist && !existsSync(checked)) {
    throw new PathPolicyError(`Path does not exist: ${input}`);
  }
  if (
    existsSync(checked) &&
    !options.allowDirectory &&
    lstatSync(checked).isDirectory()
  ) {
    throw new PathPolicyError(`A file path was expected: ${input}`);
  }
  return checked;
}

export function relativeWorkspacePath(
  workspaceRoot: string,
  candidate: string,
): string {
  assertInside(workspaceRoot, candidate);
  return relative(workspaceRoot, candidate).split(sep).join("/") || ".";
}

export function ensureDirectoryInside(
  workspaceRoot: string,
  directory: string,
): string {
  const safeDirectory = resolveWorkspacePath(workspaceRoot, directory, {
    allowDirectory: true,
  });
  mkdirSync(safeDirectory, { recursive: true });
  const canonical = realpathSync.native(safeDirectory);
  assertInside(workspaceRoot, canonical);
  return canonical;
}
