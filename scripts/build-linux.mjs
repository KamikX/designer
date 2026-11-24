import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))

function run(command, args) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) {
    console.error(result.error.message)
  }
  if (result.error || result.status !== 0) {
    process.exit(result.status || 1)
  }
}

// Native dependencies must be installed on Linux x64 rather than copied from the host.
if (process.platform === 'linux' && process.arch === 'x64') {
  run('pnpm', ['build'])
  run('pnpm', ['exec', 'electron-builder', '--linux', '--x64', '--publish', 'never'])
} else {
  console.log('Building Linux amd64 in Docker. Docker must be running.')
  run('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '--file',
    'Dockerfile.linux',
    '--output',
    'type=local,dest=dist',
    '.'
  ])
}
