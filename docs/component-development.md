# Component development projects

Choose **Component development** in the project wizard to build an isolated component or a set
of components from a prompt or visual reference. This option is exclusive: selecting it clears
page targets, and selecting a page target clears it. New projects still default to Web.

The project stores `components` in the existing `targets` field. The main process rejects unknown
targets and combinations of component development with page targets. Existing projects are not
migrated or changed.

The built-in `target-components` template is loaded through the normal target skill mechanism,
including user overrides. It applies in every turn and in both tools and markers protocols.
The design seed retains theme generation but skips its separate specification page for this target.
It instructs the model to keep reusable Vue/React components in `components/` and use `App.vue`
or `App.tsx` only for preview wiring and sample data. HTML retains `index.html` with portable
component markup and separable styles and JavaScript. All stacks retain their existing preview,
attachments, versioning, export, and visual-guidance behavior.

A clear reference crop can be implemented directly. For a whole-page screenshot without a named
component or region, the agent must ask which part to build. The preview contains only the
requested components and necessary surroundings, without an application shell, catalog, or
property controls. An explicit request for a custom component permits implementing it even when
antdv-next offers a similar control; supporting controls still use the selected library.

These content boundaries are model instructions, not a semantic enforcement gate. Storybook is
not installed or configured; separating components from preview wiring leaves room for a future
integration.
