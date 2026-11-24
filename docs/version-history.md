# Project version history

Version history lets you inspect a saved project snapshot and choose the starting point for the next AI edit. Selecting an older version preserves all existing versions.

## Selecting a version

Open a project and use **Version history** beside the **Preview / Code** switch. The list shows saved versions from newest to oldest, with their version number, creation time in your local timezone, and a summary when available. The newest version is marked **Latest**.

Selecting a version updates the preview, file tree, and code viewer together. Export uses the selected version's files. If the file currently open in the code viewer exists in the selected version, it stays selected; otherwise, the first file is selected. Preview annotations are cleared when the selected version changes because they refer to elements in a particular snapshot.

The selection lasts while the project detail remains open. Reopening the project loads its newest version, including after an application restart. A project with no saved versions has no version picker.

## Continuing from an older version

The selected version is also the base for the next AI edit. When an older version is selected, the toolbar displays **Next edit starts from vN**.

For example, if a project has versions **v1**, **v2**, and **v3**:

1. Select **v1** to inspect its files and preview.
2. Send an instruction to modify the design.
3. The AI starts from **v1**'s files. Files added only in **v2** or **v3** are absent from that starting snapshot.
4. When file changes are saved, the result becomes **v4**, with **v1** recorded as its parent. Unchanged files from **v1** are inherited, while this turn's writes and deletions are applied.
5. The workspace automatically selects **v4**. Versions **v1**, **v2**, and **v3** remain available.

Version numbers always increase across the whole project, regardless of which version was selected as the parent. Selecting a version alone creates no new version, and sending a message without saved file changes does not necessarily create one either.

The conversation history remains intact when switching versions. The AI receives the existing conversation together with instructions to use the selected snapshot and avoid reapplying later changes unless requested. The file base is enforced by the application; following the conversation instructions also depends on the model.

## What a version contains

Each saved version stores a complete file snapshot in SQLite, together with its number, parent version, summary, creation time, and associated message reference. Loading a version does not require replaying earlier edits.

Project settings remain current when an older file snapshot is selected. This includes visual guidance (`styleBrief`, optional `designDocument`, and their priority), component libraries, and other project configuration. The next AI edit combines the selected files with those current settings. The preview also uses the current preview environment, so it may differ from how the same files rendered under earlier dependencies or settings.

## Loading and generation behavior

Version switching is disabled while a message is being submitted, the project is generating, or a snapshot is loading. Sending another edit is blocked while files load. Export is also disabled during snapshot loading.

The displayed version changes only after its files load successfully. If loading fails, the previous snapshot remains visible and an error is shown. Responses from an outdated loading request cannot replace a newer selection or another project's files.

Before starting an AI turn, the main process checks that the supplied base version exists and belongs to the conversation's project. Invalid or foreign version IDs are rejected before new messages are saved. Calls that omit a base version retain the existing behavior of starting from the project's newest version.
