# OpenToonz MCP

`opentoonz-mcp` is a local, safety-first [Model Context Protocol](https://modelcontextprotocol.io/) server for OpenToonz workspaces. It gives an MCP client useful, structured access to project and scene metadata, resource validation, level discovery, rendering, and level conversion without exposing a general-purpose shell.

The server is intentionally a **sidecar**. It does not patch or embed OpenToonz. Instead, it reads OpenToonz's XML-like project and scene files directly for fast inspection and invokes the existing `tcomposer` and `tconverter` command-line programs for operations that require OpenToonz's native runtime.

## Status

This repository contains the first usable read-mostly release:

- Read-only project, scene, level, and artifact discovery.
- Scene header inspection and serialized level/scanned-path extraction.
- Alias-aware resource validation for `+drawings`, `+scenes`, `$scenefolder`, `$scenepath`, and `$scenename` paths.
- Preview rendering and scene rendering through `tcomposer`.
- Level conversion through `tconverter`.
- Stdio transport for local MCP clients.
- One static resource, one scene resource template, and a reusable scene-health prompt.
- Tests for path sandboxing, symlink escape rejection, project discovery, and scene resource validation.

The server does **not** expose arbitrary command execution, arbitrary `.toonzscript` execution, `tcleanup`, render-farm administration, or direct scene mutation.

## Requirements

- Node.js 20 or newer.
- A built OpenToonz checkout if rendering or conversion is needed.
- An MCP client that supports stdio servers.

The OpenToonz source checkout used while designing this server is expected to have a layout similar to:

```text
workspace/
├── toonz/                 # OpenToonz source checkout
│   └── build/bin/
│       ├── tcomposer
│       └── tconverter
└── opentoonz_mcp/         # this repository
```

The MCP server can inspect an unbuilt workspace. Only the rendering and conversion tools require the corresponding binaries.

## Install and build

```bash
cd opentoonz_mcp
npm install
npm run typecheck
npm test
npm run build
```

The executable is written to `dist/index.js` and is also exposed as the `opentoonz-mcp` npm bin entry.

## Configure an MCP client

Build the server first, then add a stdio server entry to the client. The exact settings file varies by client; the following is the portable shape:

```json
{
  "mcpServers": {
    "opentoonz": {
      "command": "node",
      "args": ["/absolute/path/to/opentoonz_mcp/dist/index.js"],
      "env": {
        "OPENTOONZ_WORKSPACE": "/absolute/path/to/opentoonz_project_and_mcp/opentoonz",
        "OPENTOONZ_BUILD_DIR": "/absolute/path/to/opentoonz_project_and_mcp/opentoonz/toonz/build",
        "OPENTOONZ_ROOT": "/absolute/path/to/opentoonz_project_and_mcp/opentoonz"
      }
    }
  }
}
```

`OPENTOONZ_WORKSPACE` is the important setting. If it is omitted, the current working directory is used. When the server is started from a directory named `opentoonz_mcp` with a sibling `opentoonz` directory, the sibling is selected as a convenience fallback.

### Configuration variables

| Variable                                | Default                                      | Purpose                                                                                        |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `OPENTOONZ_WORKSPACE`                   | current directory, or sibling `../opentoonz` | Root directory that all paths must remain inside                                               |
| `OPENTOONZ_ROOT`                        | workspace root                               | OpenToonz runtime root; the server seeds isolated `SystemVar.ini` and passes it as `TOONZROOT` |
| `OPENTOONZ_BUILD_DIR`                   | `$WORKSPACE/toonz/build`                     | Directory containing `bin/tcomposer` and `bin/tconverter`                                      |
| `OPENTOONZ_TCOMPOSER`                   | discovered build binary                      | Explicit `tcomposer` path                                                                      |
| `OPENTOONZ_TCONVERTER`                  | discovered build binary                      | Explicit `tconverter` path                                                                     |
| `OPENTOONZ_ARTIFACT_DIR`                | `.mcp-artifacts` inside workspace            | Default output directory for generated artifacts                                               |
| `OPENTOONZ_RUNTIME_HOME`                | `.mcp-artifacts/.runtime` inside workspace   | Isolated `HOME`, XDG config, and cache root for native subprocesses                            |
| `OPENTOONZ_LIBRARY_PATH`                | `$BUILD_DIR/lib/opentoonz` when present      | Optional native library path for build-tree binaries                                           |
| `OPENTOONZ_MCP_TIMEOUT_MS`              | `120000`                                     | Default subprocess timeout                                                                     |
| `OPENTOONZ_MCP_MAX_OUTPUT_BYTES`        | `2000000`                                    | Captured stdout/stderr limit per subprocess                                                    |
| `OPENTOONZ_MCP_MAX_SCAN_ENTRIES`        | `10000`                                      | Filesystem discovery limit                                                                     |
| `OPENTOONZ_MCP_MAX_METADATA_BYTES`      | `32000000`                                   | Maximum project, scene, and `scenes.xml` metadata file size                                    |
| `OPENTOONZ_MCP_MAX_INSPECT_CONCURRENCY` | `4`                                          | Maximum concurrent metadata inspections                                                        |

## Capabilities

### Tools

| Tool                       |        Writes files? | Description                                                |
| -------------------------- | -------------------: | ---------------------------------------------------------- |
| `workspace_manifest`       |                   No | Workspace roots, discovered counts, and available binaries |
| `list_projects`            |                   No | Finds project descriptors and parses folder aliases        |
| `inspect_project`          |                   No | Inspects one project descriptor                            |
| `list_scenes`              |                   No | Finds `.tnz` and `.tab` scenes                             |
| `inspect_scene`            |                   No | Reads scene header and serialized resource references      |
| `validate_scene_resources` |                   No | Resolves aliases and reports missing/external resources    |
| `list_level_files`         |                   No | Lists recognized level and image files                     |
| `list_artifacts`           |                   No | Lists files produced by this server                        |
| `render_preview`           |   Yes, artifact only | Renders one frame with `tcomposer`                         |
| `render_scene`             | Yes, artifact/output | Renders a frame or frame range with `tcomposer`            |
| `convert_level`            | Yes, new output only | Converts a level with `tconverter`                         |

All generated outputs must be new paths inside the configured workspace. Existing files are rejected before OpenToonz starts, which prevents `tconverter` from blocking on its interactive overwrite prompt.

Rendering is stricter than inspection: `render_preview` and `render_scene` first validate that all discovered scene resources are present and resolve inside the configured workspace. Scenes that intentionally depend on external media must be copied into the workspace or handled outside this MCP server.

### Resources and prompt

- `opentoonz://workspace/manifest` — live JSON workspace manifest.
- `opentoonz://scene/{+path}` — read-only scene summary resource template. The reserved URI expansion allows nested workspace-relative paths.
- `review-scene-health` — prompt that directs an MCP client to inspect a scene and validate its resources before discussing changes.

## Safety model

1. **Workspace sandbox:** relative and absolute inputs are canonicalized and checked against `OPENTOONZ_WORKSPACE`.
2. **Symlink escape protection:** existing paths are resolved through the filesystem before the containment check.
3. **No shell:** subprocesses use `spawn()` with an argument array and `shell: false`.
4. **Bounded execution:** render and conversion calls have a timeout and bounded captured output.
5. **No accidental overwrite:** generated outputs must not exist before an operation starts.
6. **No arbitrary scripts:** `.toonzscript` execution is intentionally not exposed.
7. **Read-only first:** the initial API focuses on inspection and artifact-producing operations; it does not save scenes or levels in place.

See [docs/architecture.md](docs/architecture.md) for the rationale and extension rules.

## Development

Useful commands:

```bash
npm run dev          # start the stdio server with tsx
npm run typecheck    # TypeScript validation, including tests
npm test             # node:test suite through tsx
npm run build        # production JavaScript in dist/
```

Do not print diagnostics to stdout while the server is running: stdout is the MCP JSON-RPC channel. Operational diagnostics belong on stderr.

## OpenToonz integration notes

OpenToonz scene files are not a stable public JSON format. The server therefore limits direct parsing to stable, low-risk metadata patterns: the scene header and `<path>` / `<scannedPath>` values used by serialized level records. Rendering and conversion are delegated to OpenToonz's own binaries so codec and scene behavior remain native to the installed build.

The source repository contains upstream and origin remotes for OpenToonz. This MCP implementation remains in its own repository so it can evolve independently and avoid mixing MCP changes with the OpenToonz application history.

## License

This MCP server is released under the MIT License. OpenToonz itself remains under its own license; see the OpenToonz checkout for its licensing terms and third-party notices.
