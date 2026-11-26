# External project libraries

Open **Settings → Libraries → Install npm package**. Enter the public npm package
name and an exact version, select Vue 3 and/or React, and provide a description
and instructions for the design agent. Installation requires internet access.

The default package export is always available. Add full import specifiers such
as `zod/v4` under **Additional import paths**, one per line. Add package-relative
CSS paths such as `dist/style.css` under **Package CSS paths**. CSS and its local
assets are bundled and loaded automatically; generated components do not need
to import these stylesheets themselves.

Select installed libraries when creating a Vue/React project or in the workspace's
library picker. Each project selects one exact version per package. Selecting a
new version does not change any other project. The preview refreshes on selection;
the agent receives the selected versions, allowed imports and instructions on its
next turn. Instructions can be edited globally without reinstalling a package.

## Local installation and compatibility

Packages, lockfiles, compiled ESM modules, CSS and assets are stored under
`~/.antd-designer/libraries/`, or `$ANTD_DESIGNER_HOME/libraries/` when overridden.
An installed library's preview resources work offline. Library code may still
make its own network requests. The existing built-in Antdv libraries retain their
CDN loader and are marked separately in the catalog.

Only browser-compatible public npm packages are supported. Installation scripts
are disabled. Node native modules, private registries, HTML projects and custom
build plugins are unsupported. Vue plugins require explicit registration in the
generated source; custom libraries are not automatically registered with `app.use`.
For Vue projects, put initialization in an optional root `app.setup.ts` (or
`app.setup.js` for JavaScript). Default-export a function receiving the host Vue
app. The preview awaits this function after built-in library setup and before
mounting `App.vue`; do not create or mount another app. If both files exist,
`app.setup.ts` takes precedence. Projects without either file require no changes.
Hook import, export and initialization errors use the preview error channel and
prevent mounting. React and HTML projects do not run this hook.

For example, with Vue Router selected and `router.ts` exporting the router:

```ts
import type { App } from 'vue'
import router from './router'

export default async function setup(app: App): Promise<void> {
  app.use(router)
  await router.isReady()
}
```

Use `createWebHashHistory()` in preview router definitions so navigation preserves
the preview resource path. The hook does not install npm packages or make unselected
libraries available. Components and libraries used only through imports need no
setup file. Exported source includes the hook as a normal project file; an external
host must call and await it before mounting, just as the preview does.

Libraries must be compatible with the preview's bundled Vue/React versions. Their
peer dependencies are resolved against these versions; conflicting peers fail
installation rather than silently replacing the runtime. Missing optional peer
dependencies that are actually imported by the selected entrypoints are installed
automatically and pinned in the lockfile; unused optional peers are left out. Vue/React imports and
React's JSX runtime share the preview's existing framework instances.

Library bundles replace Vue compile-time flags with production defaults:
Options API enabled, production devtools and hydration mismatch details disabled.
This also applies to plugins such as Vue Router when Vue itself is external.
Libraries prepared before this support was added need **Reinstall** in
**Settings → Libraries** to rebuild them; restarting the app alone does not rebuild
existing library bundles. Do not add global flag shims to generated project files.

Removing an installed version is blocked while any project references it. A missing
compiled file is reported as an unavailable installation; reinstall the same
version to repair it. No fallback to another version or CDN is performed. An
interrupted or failed installation is not published as an installed library.

Source exports include `designer-libraries.json` describing the selected library
versions and entry paths. This manifest does not turn the exported files into a
standalone build or add project import support.

Project archive imports copy missing prepared libraries without running package
scripts. If the same version is already installed with different contents or
instructions, the import keeps the local copy and displays a warning. Review the
imported project's preview because the local build may behave differently. Reuse
requires all archived framework targets and import entrypoints to remain available,
and a local stylesheet when the archived library includes styles. Incompatible or
incomplete local installations still block import; repair them in Settings → Libraries.

## Validation

Unit/integration tests cover local bundles, shared framework imports, CSS/assets,
project references, isolated preview routes, prompt context, and failed installs.

The packaged-app smoke test also checks the settings UI and real npm installation.
Launch an unsigned test build with `ANTD_DESIGNER_HOME` set to an empty disposable
`/tmp` directory, a `config.json` containing `{"lang":"en-US"}`, and
`DESIGNER_DEBUG_PORT=9235`. Restrict its `PATH` to `/usr/bin:/bin` to verify that
system Node/npm are unnecessary. Then run:

```sh
SMOKE_DATA_DIR=/tmp/your-test-directory node scripts/libraries-smoke.mjs
```

The script installs Zod, Tailwind Variants and NProgress, creates Vue/React test
projects, blocks HTTP(S) for the preview, verifies rendered output, Tailwind classes
and installed CSS, and writes screenshots to the disposable directory. Stop the
test application afterwards.
