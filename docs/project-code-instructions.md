# Project Code Generation Instructions

Project code instructions define reusable technical requirements for the code generated in a project. They are included automatically in each design turn, so users do not need to repeat conventions in every message.

Typical uses include specifying how to use selected libraries, organize component files, validate forms, and localize interface text.

## Configure Instructions

1. Open a project and its **Project settings** dialog.
2. Enter instructions in **Code generation rules**, below the project description.
3. Save the settings. The instructions apply from the next message onward.

The field accepts multiline text, including Markdown and code examples. Saving trims leading and trailing whitespace while preserving internal formatting. Clear the field and save to remove the instructions.

Instructions belong to one project and apply to its design conversations. They are not global preferences and do not apply to independent chats or collaboration groups. New projects start with empty instructions; the project creation form has no instructions field.

Changes do not modify existing generated files automatically. Ask the agent to revise those files if they need to adopt new conventions. A turn already in progress continues with the instructions loaded when it started.

## Example

```text
Follow these conventions when generating code:

- Validate form input with the selected version of Zod.
- Define reusable component variants with tailwind-variants.
- Split each base component into Component.vue, Component.type.ts,
  Component.variants.ts, and Component.stories.ts.
- Keep all user-facing text in translation resources, including validation
  messages, placeholders, empty states, and accessibility labels.
- Provide Slovak and English translations using consistent keys.
- Before using an unfamiliar library API, check its official documentation
  for the selected version. If documentation is unavailable, state the limitation.
```

Select and prepare the required libraries separately. A written requirement to use a package does not make it available in the preview.

Prefer specific, observable requirements such as file names, import conventions, and translation rules over broad requests such as "write production-ready code."

## How the Agent Receives Instructions

For each design turn, the application reads the project's current configuration and builds the system prompt. Nonempty instructions appear in a separate **Project code instructions** section in both supported protocols:

- **Tools:** the agent reads and changes generated files through tools.
- **Markers:** the agent returns full files using the file marker protocol.

The section is part of the stable project prefix, after the technical stack and external library descriptions and before the craftsmanship baseline and skill catalog. It is separate from per-turn file context and diagnostics. Empty or whitespace-only instructions produce no section.

The wrapper is localized to the prompt language; the user's instructions retain their original language and content. Triple backticks in user text are escaped before insertion so examples cannot close the enclosing code fence.

The instructions are available without activating a skill. They do not become generated files or a separate artifact.

## Priority and Boundaries

The prompt tells the agent to apply the following technical instruction priority:

1. A specific user request in the current turn.
2. Project code instructions.
3. General code-style recommendations in skills and library usage notes.

Project instructions cannot override preview technical contracts, available dependencies, tool authorization, safety, accessibility, or the existing visual-guidance mechanism. Embedded examples are treated as code or data, not as role changes or authorization.

Keep project-wide visual direction in **Visual style** and **DESIGN.md**. Code instructions do not replace those sources or change their selected priority.

Instructions can ask the agent to consult documentation, but they do not enable web access, select MCP servers, activate skills, install packages, or authorize local directories. Those capabilities must be made available through their existing controls. The prompt requires the agent to state a limitation when a required document or capability is unavailable.

Compliance is guided by the prompt. This feature adds no dedicated code validator that mechanically enforces the written conventions.

## Persistence and Portability

- SQLite is the source of truth: `projects.code_instructions` stores the text, exposed as `Project.codeInstructions`.
- A migration adds the column with an empty-string default for existing projects.
- Full project ZIP export includes the current instructions in `project.json`. Import preserves them; older packages without the field default to empty instructions.
- Selecting an older generated version does not restore historical instructions. Project configuration remains current.
- Source-file export does not include project instructions. Use full project export to transfer them with the project.
- Instructions are stored on the project row for future row-based synchronization. The synchronization engine is currently a placeholder; this feature does not implement transfer between devices.

## Implementation Entry Points

- `src/main/db/repo/project.ts`: validates and saves text through `setProjectCodeInstructions`.
- `window.api.project.setCodeInstructions(id, instructions)`: renderer API, connected through preload and the `project:set-code-instructions` IPC channel; returns the updated project or `null` if it does not exist.
- `src/renderer/src/pages/project/components/ProjectSettingsButton.vue`: editing UI; the project store updates both list and active-project snapshots after saving.
- `src/main/ai/prompts/index.ts`: includes the instructions in the stable prompt prefix.
- `src/main/project-package/format.ts` and `service.ts`: project package compatibility and import/export.

Tests cover saving and clearing instructions, project isolation, migration defaults, both prompt protocols, empty-section omission, code-fence escaping, export/import, and legacy packages.
