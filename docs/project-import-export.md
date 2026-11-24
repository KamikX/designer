# Full Project Import and Export

Full project export creates a ZIP package that can be imported into AI Designer as a new project. It preserves the complete version history through file-level increments and opens the version selected at export time. Import never replaces or merges into an existing project.

## Usage

### Export a project

1. Open the project and select the version to restore after import.
2. In the top-right project header, open **Export** and choose **Export project**.
3. Choose where to save the ZIP package. The default filename is `project.designer.zip`.

The package includes every saved version, including versions newer than the selected one. Selecting an older version changes the version initially opened after import; it does not truncate history or restore historical project settings. Project metadata and visual guidance reflect their current persisted values.

Empty projects can also be exported. Export is unavailable while the project is generating. Missing or corrupt referenced assets, unavailable external library files, or exceeded package limits cause export to fail rather than produce an incomplete package.

### Import a project

1. On the project home page, choose **Import project**. This action is also available when the project list is empty.
2. Select a project ZIP package produced by **Export project**.
3. After import, the application opens the new project at the exported selection.

If the project name already exists, import appends a numeric suffix, for example `Project (2)`. Importing the same package again creates another independent project. Canceling either file dialog makes no changes.

### Export source files

**Export source files** remains a separate operation. It writes only the selected version's source tree and `designer-libraries.json` into a directory. It does not include project history or the project package manifest. Such a directory cannot be used for full project import.

## Included and Excluded Data

| Data                              | Package behavior                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project configuration             | Includes name, description, stack, design mode, targets, and library selections.                                                                                                |
| Visual guidance                   | Includes StyleBrief, DESIGN.md content, and the selected source priority.                                                                                                       |
| Versions                          | Includes all saved versions, incremental source trees, summaries, version numbers, parent relationships, and timestamps.                                                        |
| Conversation history              | Includes project design conversations, messages, saved question answers, image references, and recorded message usage. Independent chats and collaboration groups are excluded. |
| Project and conversation settings | Includes skill/MCP selections, web search choice, tool-call limit, and a portable model selection.                                                                              |
| Assets                            | Includes referenced binary data from local storage or S3, with MIME type, size, and checksum. References inside textual assets, including SVG, are followed recursively.        |
| External libraries                | Includes installed library metadata and prepared preview files. Import does not download packages or run installation scripts.                                                  |
| Machine configuration             | Excludes provider definitions and API keys, MCP configuration and credentials, skill definitions, storage credentials, and global application settings.                         |
| Local permissions                 | Excludes authorized workspace roots and their contents. Directory access must be granted again on the destination installation.                                                 |
| Operational data                  | Excludes diagnostics, aggregate usage tables, synchronization bookkeeping, and derived caches.                                                                                  |

Remote HTTP resources referenced by project content are not downloaded into the package. Built-in preview dependencies remain supplied by the destination application or its configured CDN; the package is not an offline copy of the application runtime.

## Restoration Rules

- Projects, conversations, messages, versions, file records, and assets receive new IDs. Internal relationships, image references, and `asset://` URIs are remapped.
- Version numbers and timestamps are preserved. New message IDs preserve the original ordering when messages share a timestamp.
- Imported assets are stored locally, regardless of their original backend or the destination's active storage setting. References inside textual assets are rewritten, and their sizes and checksums are recalculated.
- Model selection is matched by provider slug and API model name, then mapped to the destination's model record. Both the provider and the chat model must be enabled.
- Skills are matched against installed skill names. MCP selections are matched against configured, enabled server names. Missing selections are omitted and listed in the import warning.
- Skill and MCP definitions are never installed by project import.
- An existing external library with the same name and version is reused only when its metadata and prepared file contents match. Installation timestamps are ignored during comparison. A content conflict aborts import without overwriting the installed library.
- The restored selection is persisted as `settings.selectedArtifactId`. Subsequent successful version selections update this field. Loading a project with an absent or invalid saved selection falls back to the latest version.

## Readable Incremental Format

```text
manifest.json
project.json
STYLE.md
DESIGN.md
versions/
  v0001/
    version.json
    files/<original-path>
  v0002/
    version.json
    files/<added-or-changed-path>
conversations/
  <conversation-id>/
    conversation.json
    messages/<message-id>.json
assets/
  <asset-id>.<extension>
libraries/
  <package-name>/<package-version>/
    library.json
    files/<prepared-file-path>
```

The manifest identifies the format as `ai-designer-project-incremental`. It contains the selected artifact ID, a checksummed document index, and asset metadata. Project configuration is stored in `project.json`; StyleBrief and DESIGN.md content are stored only in `STYLE.md` and `DESIGN.md`. Each conversation and message has a separate JSON document. Prepared library files keep their paths under the package name and version, including the scope for scoped packages. Asset filenames use their stable IDs and MIME-derived extensions, with `.bin` for unknown types.

Each `version.json` contains the artifact metadata, `writes`, `deleted`, and a complete `files` inventory. The inventory records each resulting file's ID, original path, byte size, SHA-256, and timestamps; it does not repeat file contents.

A version is compared against its actual `baseArtifactId`, not the preceding version number. Every root with no parent stores its full initial tree. A child stores the complete contents of added or changed files and lists deleted paths. Unchanged files are inherited; metadata-only changes do not duplicate source contents. Renaming is represented as deletion plus addition. There are no text patches or periodic full snapshots.

Import processes parents before children and assembles each version once. It inherits payload references, applies deletions and writes, and checks that the resulting tree exactly matches its inventory. The existing SQLite representation still stores complete file trees for every restored version; the database schema is unchanged. Decoded source caching is bounded to 16 MiB, and export reads source contents in bounded batches into a temporary working directory instead of loading every historical tree at once. ZIP assembly and parsing still use in-memory archive buffers.

Only this layout is supported. There is no legacy package reader or migration path.

### Tracking an export in Git

Export the ZIP, unpack it outside the application's data directory, and track the unpacked files in your repository. The application does not manage Git, import directories, or update an existing repository. When updating a tracked export, remove stale exported files as part of your own replacement process while preserving `.git` and unrelated repository files.

Source files retain their original paths and exact UTF-8 contents, including BOMs and line endings. JSON uses stable key and collection ordering, two-space indentation, and a final LF. Export adds no new identities or export timestamp. Re-exporting an unchanged project produces identical unpacked paths and contents; adding a version leaves existing version documents and payloads unchanged. Changing only the selected version changes the manifest.

Each incremental version directory is not necessarily a standalone runnable project. Use **Export source files** to obtain a complete source tree for the selected version. Manual edits to package contents are not a supported import workflow: mismatched checksums are rejected.

### Validation and limits

The importer validates document schemas, checksums, unique identities, project ownership, message/version relationships, parent ordering, selected version, library metadata, and asset references, including references inside textual assets such as SVG. File inventories and restored size limits are checked before creating project data.

Archive validation rejects absolute or traversing paths, backslash paths, symbolic links, duplicate or case/Unicode-normalized alias paths, file/directory conflicts, unexpected payloads, missing payloads, and invalid UTF-8 text. Increment validation rejects missing or cyclic parents, duplicate operations, deletion of nonexistent paths, conflicting writes and deletions, and any mismatch between the reconstructed tree and its inventory.

| Limit                                             | Maximum |
| ------------------------------------------------- | ------- |
| ZIP file size                                     | 512 MiB |
| Total declared uncompressed entry size            | 1 GiB   |
| ZIP entries                                       | 50,000  |
| Total source content across all restored versions | 4 GiB   |
| Restored source file records                      | 250,000 |

Restored limits count inherited files for every version, even when their contents occur only once in the ZIP. The byte limit applies before asset URI remapping and excludes database indexes and overhead.

Export validates its generated package with the same reader before publishing it. Database rows are captured in one transaction before asynchronous asset reads. The finished ZIP is written to a temporary directory beside the destination and renamed into place only after successful creation. Temporary export workspaces are removed on success or failure.

Import validates the package before creating project data. Assets and missing prepared libraries are written before the database transaction. If a handled import failure occurs, database changes are rolled back and only files or library directories created by that import are removed. Existing projects, assets, and library installations remain untouched.

## Implementation and Verification

- [`src/main/project-package/format.ts`](../src/main/project-package/format.ts): schemas, limits, checksums, incremental reconstruction, and ZIP reader.
- [`src/main/project-package/service.ts`](../src/main/project-package/service.ts): database snapshot, export, ID remapping, settings restoration, import transaction, and file dialogs.
- [`src/main/project-package/writer.ts`](../src/main/project-package/writer.ts): bounded temporary staging and deterministic archive layout.
- [`src/main/libraries/service.ts`](../src/main/libraries/service.ts): prepared library transfer and conflict handling.
- [`src/shared/types.ts`](../src/shared/types.ts): shared IPC contract.

The public renderer API is:

```ts
window.api.project.exportPackage({ projectId, selectedArtifactId })
// Promise<string | null>; selectedArtifactId is null for an empty project.

window.api.project.importPackage()
// Promise<{ project: Project; warnings: string[] } | null>
```

The corresponding IPC channels are `project:export-package` and `project:import-package`. Both APIs return `null` when their dialog is canceled; validation and processing failures reject the call.

Regression coverage is in [`src/main/project-package/service.test.ts`](../src/main/project-package/service.test.ts) and [`src/renderer/src/stores/artifact.test.ts`](../src/renderer/src/stores/artifact.test.ts). It covers complete round trips, branches and multiple roots, file changes and deletions, exact source preservation, deterministic exports, older selected versions, repeated imports, empty projects, local/S3 assets, nested SVG references, model and skill/MCP matching, library conflicts, rollback, invalid archives and increments, restored limits, and selection ownership. A scale test restores 100 versions with 1,000 files each while storing only the root files and subsequent changes in the ZIP.

Run the required checks before delivery:

```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```
