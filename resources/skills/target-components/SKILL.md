---
name: target-components
description: Develop isolated reusable components or component sets from prompts or visual references, with a minimal preview. Use for component development projects, not complete pages or applications.
metadata:
  kind: target
  target: components
---

# Component development

Deliver only the requested component or component set, its necessary dependencies, and a minimal
preview. This target defines the deliverable boundary, not a visual style.

## Interpret and clarify

Start with one sentence: “Build <component or set> for <purpose>, with <requested behavior>.”
When the scope is clear, proceed without a component questionnaire, subject to the existing
initial visual-direction confirmation rules. Ask only about missing information essential to
the component's scope or behavior, using the shared question limits.

- A clear image crop or an explicitly named region identifies the component to implement.
- If a reference shows a whole page and no component or region is specified, ask which part to
  build before writing files. Do not automatically turn the page into a component set.
- Treat images as visual references; do not invent hidden behavior, data contracts, or product
  features. If an essential interaction cannot be inferred, ask about it.

## Deliverable boundary

- Build the requested components only. Do not add an application shell, site navigation, hero,
  footer, dashboard, or unrelated sections. A navigation or hero component is allowed when it
  is itself the requested deliverable.
- Implement requested interactions and relevant states, including keyboard and focus behavior
  for interactive controls. Do not add unrelated workflows or a backend.
- Keep components independent of preview-only data, surrounding layout, and application state.
  Pass data and configuration through explicit inputs; expose interactions through events or
  callbacks. Use composition or slots/children when the requested behavior needs them.
- For Vue 3, put reusable SFCs in `components/` with typed props and emits. `App.vue` only wires
  the minimal example, sample data, and any required providers.
- For React, put reusable TSX components in `components/` with typed props and callbacks.
  `App.tsx` only wires the minimal example, sample data, and any required providers.
- For HTML, retain `index.html` and keep the component markup identifiable and portable.
  Separate component styles and behavior from preview-only styles and sample wiring when
  needed. Use native JavaScript; do not introduce a framework or build system.
- Preserve the stack's existing entry and import rules. Do not generate Storybook configuration,
  stories, dependencies, or a new runtime.

## Minimal preview

Show the requested component or set with only enough surrounding space and example data to
exercise it. Include requested variants or states without generating a catalog, property-control
panel, or decorative presentation page. Keep demo data and handlers in the preview entry.
Use only dependencies available in the existing preview environment.

## Visual guidance

Follow project StyleBrief and optional DESIGN.md under their selected priority, and consume the
shared semantic tokens from `theme.css`. Do not define a target-specific theme or fallback.
Preserve the upstream visual-confirmation, continuity, and local-exception rules. A reference for
one component does not by itself authorize changing the project's global visual direction.

## Before delivery

- Are reusable components separate from demo data and preview wiring?
- Does the existing preview entry mount the requested components successfully?
- Can the requested interactions be exercised, including keyboard use where applicable?
- Are only the requested components and necessary preview surroundings present?
- Are appearance and tokens consistent with the project's recorded visual guidance?
