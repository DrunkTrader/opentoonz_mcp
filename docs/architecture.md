# Architecture and extension rules

## System shape

```text
MCP client
   │ stdio JSON-RPC
   ▼
opentoonz-mcp
   ├── path policy
   ├── workspace scanner
   ├── project/scene metadata parser
   ├── artifact policy
   └── OpenToonz subprocess adapter
          ├── tcomposer
          └── tconverter
```

The server is a local sidecar rather than a plugin inside the OpenToonz GUI. This keeps the protocol process small, avoids linking against Qt/OpenToonz libraries, and lets the installed OpenToonz build remain the authority for rendering and media conversion.

## Module responsibilities

- `src/config.ts` — environment-based configuration and safe defaults.
- `src/paths.ts` — canonicalization, workspace containment, and artifact-directory creation.
- `src/workspace.ts` — bounded filesystem discovery, project XML parsing, scene header/reference parsing, alias resolution, and resource validation.
- `src/runner.ts` — allowlisted `tcomposer`/`tconverter` subprocesses, timeout handling, output capture, and artifact collection.
- `src/server.ts` — MCP tool/resource/prompt registration and JSON-friendly error results.
- `src/index.ts` — stdio transport entrypoint. It does not write protocol diagnostics to stdout.

## Why direct scene editing is not enabled

OpenToonz scene persistence is a custom stream format. Although it resembles XML, many values are serialized through native persistence classes and are not safe to edit with generic XML tooling. A future write-capable surface should use one of these approaches:

1. A narrowly scoped native OpenToonz worker linked against the same libraries as the target build.
2. A reviewed and allowlisted `.toonzscript` operation with a dedicated capability flag, dry-run output, backup/hash capture, and explicit operator confirmation.

Generic search-and-replace edits to `.tnz` files are not an acceptable extension path.

## Path resolution policy

OpenToonz commonly stores logical paths using:

- Project aliases such as `+drawings` and `+scenes`.
- Scene aliases such as `$scenefolder`.
- Scene-name expansions such as `$scenepath` and `$scenename`.

The parser resolves these only when the project folder is known. It reports unresolved aliases as warnings instead of guessing. A path that resolves outside the workspace is reported as external and is never read by the server's validation logic.

Level sequences are handled conservatively. If a serialized path contains an OpenToonz sequence marker such as `name..tif`, validation checks for matching files such as `name.0001.tif` without rewriting the scene's original path.

## Subprocess rules

Only two executables are allowlisted:

- `tcomposer` for rendering.
- `tconverter` for level conversion.

Each invocation:

- Uses `spawn()` with an argument array and `shell: false`.
- Uses the configured workspace as its working directory.
- Seeds the isolated OpenToonz `SystemVar.ini` and supplies `TOONZROOT` when configured.
- Sets `QT_QPA_PLATFORM=offscreen`.
- Supplies `TOONZROOT` when configured.
- Has a timeout and bounded stdout/stderr capture.
- Runs with an allowlisted environment and an isolated workspace-local runtime home.
- Refuses an existing destination before starting.

The server does not expose `exec`, `bash`, arbitrary executable paths, render-farm controls, or `tcleanup` in the first release.

Rendering additionally requires scene resource validation to pass. This keeps the native renderer from following external scene references behind the MCP server's back. Inspection can still report external references so an operator can decide how to stage them.

## Adding a new capability

Before adding a tool:

1. Decide whether it is read-only, artifact-producing, or mutating.
2. Add a strict Zod input schema.
3. Route every path through `resolveWorkspacePath()`.
4. Keep subprocess invocation in `runner.ts`; do not spawn from an MCP handler.
5. Refuse interactive commands or supply an explicit non-interactive mode.
6. Return structured JSON plus a concise human-readable error on failure.
7. Add a fixture-based test for the new parser or policy behavior.
8. Update the tool table and safety model in `README.md`.

## Future phases

### Native scene inspection worker

A small C++ helper could use `ToonzScene::loadNoResources()`, `TProjectManager::loadSceneProject()`, and `TLevelReaderP::loadInfo()` for more accurate metadata. It should be versioned against the OpenToonz build and remain an optional capability because native build dependencies are substantial.

### Controlled scene edits

Potential write operations include inserting cells, changing level paths, or updating output properties. Each should have a separate tool, a dry-run mode, a content hash before/after, a backup, serialized per-workspace execution, and an explicit confirmation parameter. A general "edit scene" tool should not be added.

### Remote transport

The first release uses stdio because it is intended for a local desktop OpenToonz workspace. A future remote deployment should use Streamable HTTP with authentication, host restrictions, per-workspace authorization, and a separate threat model. It must not simply expose the current local server to a network socket.
