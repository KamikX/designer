// Monaco 0.56 maps './*' to './esm/vs/*.js', so imports must omit esm/vs.
import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

// Load only the editor features we use because editor.api provides just the core.
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution'

/**
 * Keep Monaco lightweight and compatible with our single editor worker.
 *
 * Do not import the 'monaco-editor' root entry: it loads editor.main, including
 * dozens of Monarch languages and the TS / CSS / HTML / JSON language services.
 * Besides adding several MB, those services request language-specific workers
 * whose protocols are incompatible with the editor worker we provide.
 *
 * Import only editor.api and let Shiki handle syntax highlighting (see ./highlighter).
 * Register language IDs ourselves so Monaco does not load its language services.
 */
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export { monaco }
