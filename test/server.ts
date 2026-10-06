import { spawn, type ChildProcess } from 'node:child_process'
import { after } from 'node:test'

const children: ChildProcess[] = []
after(() => { for (const child of children) child.kill() })

/** Starts a Node script, waits until it logs its port, and stops it after the tests of the file. */
export async function start(args: string[], env: Record<string, string> = {}): Promise<{ base: string; process: ChildProcess }> {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const base = await new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += chunk
      const port = /(?:listening on|on) :(\d+)/.exec(output)?.[1]
      if (port) resolve(`http://localhost:${port}`)
    })
    child.stderr!.on('data', (chunk) => { output += chunk })
    child.on('exit', (code) => reject(new Error(`process exited (${code}):\n${output}`)))
  })
  return { base, process: child }
}

/** Starts faux-idc with an inline config and no config file. */
export const startServer = (configYaml: string, env: Record<string, string> = {}) =>
  start(['--import', 'tsx', 'src/index.ts'], {
    PORT: '0', CONFIG_PATH: '/nonexistent/config.yaml', CONFIG_YAML: configYaml, ISSUER: '', ...env,
  }).then((s) => s.base)

/** Starts test/fake-entra.mjs on a free port. */
export const startFakeEntra = () => start(['test/fake-entra.mjs'], { PORT: '0' }).then((s) => s.base)
