import AdmZip from 'adm-zip'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalJson, hash, PACKAGE_LIMITS, PackagePaths, readPackage } from './format'
import type { PackageManifest } from './format'

/** Stage only changed payloads, not all historical full trees, while the database snapshot is open. */
export class PackageWriter {
  private root = mkdtempSync(join(tmpdir(), 'designer-package-'))
  private paths = new PackagePaths()
  private entries = new Map<string, string>()
  private expanded = 0
  readonly documents: PackageManifest['documents'] = []

  write(path: string, data: Buffer): { size: number; sha256: string } {
    this.paths.add(path)
    if (
      this.entries.size + 1 > PACKAGE_LIMITS.entries ||
      this.expanded + data.length > PACKAGE_LIMITS.expanded
    )
      throw new Error('Expanded package exceeds size or entry count limit')
    const target = join(this.root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data, { flag: 'wx' })
    this.entries.set(path, target)
    this.expanded += data.length
    return { size: data.length, sha256: hash(data) }
  }

  document(path: string, value: unknown): void {
    this.textDocument(path, canonicalJson(value))
  }

  textDocument(path: string, data: Buffer): void {
    this.documents.push({ path, ...this.write(path, data) })
  }

  finish(selectedArtifactId: string | null, assets: PackageManifest['assets']): Buffer {
    this.document('manifest.json', {
      format: 'ai-designer-project-incremental',
      selectedArtifactId,
      documents: [...this.documents].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
      ),
      assets: [...assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    })
    const zip = new AdmZip()
    for (const path of [...this.entries.keys()].sort()) {
      zip.addFile(path, readFileSync(this.entries.get(path)!))
      zip.getEntry(path)!.header.time = new Date(1980, 0, 1)
    }
    const data = zip.toBuffer()
    // Export and import share validation, including the logical size of inherited files.
    readPackage(data)
    return data
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}
