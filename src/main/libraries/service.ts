import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import electron from 'electron'
import type { BuildResult } from 'esbuild'
import { z } from 'zod'
import { DATA_DIR } from '../paths'
import type {
  ExternalLibraryRef,
  InstalledLibrary,
  InstallLibraryInput,
  LibraryProgress,
  PreviewLib,
  Stack
} from '../../shared/types'

const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
const version = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.split('/').some((v) => !v || v === '.' || v === '..') &&
      !p.includes(':')
  )
export const installSchema = z
  .strictObject({
    name: packageName,
    version,
    stacks: z
      .array(z.enum(['vue3', 'react']))
      .min(1)
      .max(2),
    description: z.string().max(2000),
    instructions: z.string().max(20000),
    subpaths: z.array(relativePath).max(30),
    css: z.array(relativePath).max(30)
  })
  .refine((v) => v.subpaths.every((p) => p.startsWith(`${v.name}/`)), {
    error: 'Subpaths must start with the package name.'
  })
const metadataSchema = installSchema.safeExtend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.iso.datetime(),
  entries: z.record(z.string(), relativePath),
  styles: z.array(relativePath),
  files: z.array(relativePath).min(1)
})
const refsSchema = z.array(z.object({ name: packageName, version })).max(100)
const ROOT = join(DATA_DIR, 'libraries')
const active = new Set<string>()

export function libraryId(ref: ExternalLibraryRef): string {
  const parsed = refsSchema.element.parse(ref)
  return createHash('sha256').update(`${parsed.name}@${parsed.version}`).digest('hex')
}

function directory(ref: ExternalLibraryRef): string {
  return join(ROOT, libraryId(ref))
}
function readLibrary(ref: ExternalLibraryRef): InstalledLibrary {
  const dir = directory(ref)
  if (!existsSync(join(dir, 'library.json')))
    throw new Error(`Library is not installed: ${ref.name}@${ref.version}`)
  const metadata = metadataSchema.parse(JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')))
  if (
    metadata.id !== libraryId(ref) ||
    metadata.name !== ref.name ||
    metadata.version !== ref.version
  )
    throw new Error('Invalid library metadata')
  const ready = metadata.files.every((p) => existsSync(join(dir, 'dist', p)))
  return { ...metadata, ready }
}

export function listLibraries(): InstalledLibrary[] {
  if (!existsSync(ROOT)) return []
  const result: InstalledLibrary[] = []
  for (const dir of readdirSync(ROOT)) {
    if (!/^[a-f0-9]{64}$/.test(dir)) continue
    try {
      const metadata = metadataSchema.parse(
        JSON.parse(readFileSync(join(ROOT, dir, 'library.json'), 'utf8'))
      )
      result.push(readLibrary(metadata))
    } catch (error) {
      console.warn(
        `[libraries] Cannot read ${dir}:`,
        error instanceof Error ? error.message : error
      )
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

export function resolveLibraries(
  refs: ExternalLibraryRef[],
  stack: Stack,
  builtins: PreviewLib[] = []
): InstalledLibrary[] {
  const parsed = refsSchema.parse(refs)
  if (parsed.length && stack === 'html') throw new Error('External libraries require Vue or React.')
  const names = new Set<string>(['vue', 'react', 'react-dom', ...builtins])
  return parsed.map((ref) => {
    if (names.has(ref.name)) throw new Error(`Duplicate or reserved library: ${ref.name}`)
    names.add(ref.name)
    const lib = readLibrary(ref)
    if (!lib.ready)
      throw new Error(
        `Library files are missing: ${ref.name}@${ref.version}. Reinstall this version.`
      )
    if (stack === 'html' || !lib.stacks.includes(stack))
      throw new Error(`Library ${ref.name}@${ref.version} does not support ${stack}`)
    return lib
  })
}

// Optional peers may be omitted by npm even though an entrypoint imports them
// (e.g. tailwind-variants 3.x's default entrypoint imports tailwind-merge).
const peerManifestSchema = z.object({
  name: z.string().optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }))
    .optional()
})
function optionalPeer(
  resolveDir: string,
  specifier: string,
  staging: string
): { name: string; range: string } | null {
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  if (!packageName.safeParse(name).success || ['vue', 'react', 'react-dom'].includes(name))
    return null
  let dir = realpathSync(resolveDir)
  const root = realpathSync(staging)
  while (dir.startsWith(root + sep)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const parsed = peerManifestSchema.safeParse(JSON.parse(readFileSync(manifest, 'utf8')))
      if (parsed.success && parsed.data.name) {
        const range = parsed.data.peerDependencies?.[name]
        return parsed.data.peerDependenciesMeta?.[name]?.optional &&
          range &&
          /^[0-9A-Za-z.*+~^<>=| -]+$/.test(range)
          ? { name, range }
          : null
      }
    }
    dir = dirname(dir)
  }
  return null
}

export async function installLibrary(
  raw: InstallLibraryInput,
  progress: (event: LibraryProgress) => void = () => {}
): Promise<InstalledLibrary> {
  const parsed = installSchema.safeParse(raw)
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
  const input = parsed.data
  if (['vue', 'react', 'react-dom', 'antdv-next', '@antdv-next/icons'].includes(input.name))
    throw new Error('This package is managed by the built-in preview runtime.')
  const id = libraryId(input)
  if (active.has(id)) throw new Error('This library is already being installed.')
  let existing: InstalledLibrary | null = null
  if (existsSync(directory(input))) {
    try {
      existing = readLibrary(input)
    } catch {
      /* A damaged catalog entry may be repaired by reinstalling. */
    }
  }
  if (existing?.ready) throw new Error('This version is already installed.')
  active.add(id)
  let temp = join(ROOT, `.install-${id}`)
  const emit = (stage: LibraryProgress['stage'], message: string): void =>
    progress({ name: input.name, version: input.version, stage, message })
  try {
    mkdirSync(ROOT, { recursive: true })
    rmSync(temp, { recursive: true, force: true })
    mkdirSync(temp)
    // Arborist lockfile locations must not mix symlinked and canonical roots (e.g. /tmp on macOS).
    temp = realpathSync(temp)
    emit('installing', 'Downloading package and dependencies…')
    const appRoot = electron.app?.getAppPath() ?? process.cwd()
    const runtimes = JSON.parse(
      readFileSync(join(appRoot, 'resources/preview-vendor/runtime-versions.json'), 'utf8')
    ) as Record<string, string>
    writeFileSync(
      join(temp, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [input.name]: input.version, ...runtimes } })
    )
    const { default: Arborist } = await import('@npmcli/arborist')
    const arboristOptions = {
      path: temp,
      registry: 'https://registry.npmjs.org',
      ignoreScripts: true,
      audit: false,
      fund: false,
      binLinks: false,
      cache: join(ROOT, '.npm-cache'),
      fetchTimeout: 30000,
      fetchRetries: 1
    }
    await new Arborist(arboristOptions).reify()
    emit('building', 'Preparing offline browser modules…')
    const entries: Record<string, string> = {}
    const entryPoints: Record<string, string> = {}
    for (const [index, spec] of [...new Set([input.name, ...input.subpaths])].entries()) {
      const file = `entry-${index}`
      entries[spec] = `${file}.js`
      entryPoints[file] = `library-entry:${spec}`
    }
    input.css.forEach((p, i) => {
      entryPoints[`style-${i}`] = `${input.name}/${p}`
    })
    // spawn cannot execute paths inside ASAR. electron-builder unpacks this native binary.
    if (electron.app?.isPackaged) {
      const binary = join(
        appRoot.replace(/\.asar$/, '.asar.unpacked'),
        'node_modules',
        '@esbuild',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
      )
      if (!existsSync(binary))
        throw new Error('The packaged browser compiler is missing. Reinstall the application.')
      process.env.ESBUILD_BINARY_PATH = binary
    }
    const { build } = await import('esbuild')
    const missingPeers = new Map<string, string>()
    const attemptedPeers = new Set<string>()
    const compile = (): Promise<BuildResult<{ metafile: true }>> =>
      build({
        absWorkingDir: temp,
        entryPoints,
        outdir: join(temp, 'dist'),
        bundle: true,
        platform: 'browser',
        format: 'esm',
        splitting: true,
        metafile: true,
        logLevel: 'silent',
        conditions: ['browser', 'import'],
        define: { 'process.env.NODE_ENV': '"production"' },
        loader: {
          '.woff': 'file',
          '.woff2': 'file',
          '.ttf': 'file',
          '.eot': 'file',
          '.svg': 'file',
          '.png': 'file',
          '.jpg': 'file',
          '.gif': 'file',
          '.webp': 'file'
        },
        external: ['vue', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
        plugins: [
          {
            name: 'library-entries',
            setup(builder) {
              builder.onResolve({ filter: /^library-entry:/ }, (args) => ({
                path: args.path.slice(14),
                namespace: 'library-entry'
              }))
              builder.onLoad({ filter: /.*/, namespace: 'library-entry' }, (args) => ({
                contents: `import * as library from ${JSON.stringify(args.path)}; export * from ${JSON.stringify(args.path)}; export default Reflect.get(library, 'default');`,
                resolveDir: temp
              }))
              builder.onResolve({ filter: /^[^./]/ }, async (args) => {
                if (args.pluginData === 'optional-peer-probe') return undefined
                const peer = optionalPeer(args.resolveDir, args.path, temp)
                if (!peer || attemptedPeers.has(peer.name)) return undefined
                const resolved = await builder.resolve(args.path, {
                  kind: args.kind,
                  resolveDir: args.resolveDir,
                  importer: args.importer,
                  namespace: args.namespace,
                  pluginData: 'optional-peer-probe'
                })
                if (resolved.errors.length) missingPeers.set(peer.name, peer.range)
                return resolved
              })
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point' && !args.path.startsWith('library-entry:'))
                  return { path: resolve(temp, 'node_modules', args.path) }
                return undefined
              })
            }
          }
        ]
      })
    let result: Awaited<ReturnType<typeof compile>> | undefined
    for (let pass = 0; pass < 10; pass++) {
      missingPeers.clear()
      try {
        result = await compile()
        break
      } catch (error) {
        if (!missingPeers.size || pass === 9) throw error
        const add = [...missingPeers].map(([name, range]) => {
          attemptedPeers.add(name)
          return `${name}@${range}`
        })
        emit('installing', `Installing required optional peers: ${add.join(', ')}`)
        await new Arborist(arboristOptions).reify({ add })
        emit('building', 'Preparing offline browser modules…')
      }
    }
    if (!result) throw new Error('Unable to prepare browser modules.')
    const supportedExternal = new Set([
      'vue',
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime'
    ])
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        if (
          dependency.external &&
          !supportedExternal.has(dependency.path) &&
          !dependency.path.startsWith('data:')
        )
          throw new Error(`Unsupported external dependency: ${dependency.path}`)
      }
    }
    const files = Object.keys(result.metafile.outputs).map((p) =>
      relative(join(temp, 'dist'), resolve(temp, p)).split(sep).join('/')
    )
    const styles = files.filter((p) => p.endsWith('.css'))
    const metadata = { ...input, id, entries, styles, files, installedAt: new Date().toISOString() }
    writeFileSync(join(temp, 'library.json'), JSON.stringify(metadata, null, 2))
    // Failed installs never become visible in the catalog. Reinstall can repair missing dist files.
    rmSync(directory(input), { recursive: true, force: true })
    renameSync(temp, directory(input))
    emit('ready', 'Library is ready for offline previews.')
    return readLibrary(input)
  } catch (error) {
    emit('error', error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    active.delete(id)
    rmSync(temp, { recursive: true, force: true })
  }
}

export function updateLibrary(
  ref: ExternalLibraryRef,
  raw: { description: string; instructions: string }
): void {
  const patch = z
    .strictObject({ description: z.string().max(2000), instructions: z.string().max(20000) })
    .parse(raw)
  const { ready, ...lib } = readLibrary(ref)
  if (!ready) throw new Error('Reinstall this version before editing its instructions.')
  const path = join(directory(ref), 'library.json')
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...lib, ...patch }, null, 2))
  renameSync(`${path}.tmp`, path)
}

export function removeLibrary(
  ref: ExternalLibraryRef,
  projects: { name: string; externalLibraries?: ExternalLibraryRef[] | null }[]
): void {
  const users = projects.filter((p) =>
    p.externalLibraries?.some((r) => r.name === ref.name && r.version === ref.version)
  )
  if (users.length)
    throw new Error(`Library is used by projects: ${users.map((p) => p.name).join(', ')}`)
  if (active.has(libraryId(ref))) throw new Error('Library installation is in progress.')
  rmSync(directory(ref), { recursive: true, force: true })
}

export function libraryFile(lib: InstalledLibrary, file: string): string {
  const root = resolve(directory(lib), 'dist')
  const target = resolve(root, file)
  if (!target.startsWith(root + sep)) throw new Error('Invalid library path')
  return target
}

export function libraryPrompt(
  refs: ExternalLibraryRef[],
  stack: Stack,
  builtins: PreviewLib[] = []
): string {
  if (!refs.length) return ''
  return (
    '## Available external libraries\nOnly the following additional imports are allowed. CSS is loaded by the preview runtime.\n' +
    resolveLibraries(refs, stack, builtins)
      .map(
        (lib) =>
          `### ${lib.name}@${lib.version}\nAllowed imports: ${Object.keys(lib.entries).join(', ')}\n${lib.description}\n${lib.instructions}`
      )
      .join('\n\n')
  )
}
