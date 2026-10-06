// Regenerates the README screenshots in docs/screenshots.
// Run from the repository root:
//   npm install --no-save playwright && npx playwright install chromium
//   node docs/screenshots/capture.mjs
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const DIR = 'docs/screenshots'
const children = []

/** Starts a process and resolves when its output matches `ready`. */
function start(args, env, ready) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ISSUER: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    let output = ''
    const onData = (chunk) => {
      output += chunk
      if (ready.test(output)) resolve()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`${args.join(' ')} exited (${code}):\n${output}`)))
  })
}

const faux = (port, configPath, issuer = '') =>
  start(['--import', 'tsx', 'src/index.ts'], { PORT: String(port), CONFIG_PATH: configPath, ISSUER: issuer }, /listening on/)

const authorize = (port, clientId) =>
  `http://localhost:${port}/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:3000/callback', scope: 'openid profile',
  })}`

async function signInForm(page, username, claimSet) {
  await page.fill('input[name=username]', username)
  await page.selectOption('#claim_set', claimSet)
  await page.click('summary')
  await page.waitForFunction((name) => document.getElementById('preview').textContent.includes(name), username)
}

try {
  await Promise.all([
    faux(18101, 'config/config.yaml'),
    faux(18102, `${DIR}/configs/packs.yaml`, 'http://localhost:8080'), // the home page shows the issuer
    faux(18104, `${DIR}/configs/entra.yaml`),
    start(['test/fake-entra.mjs'], {}, /fake-entra\] on/),
  ])

  const browser = await chromium.launch()
  const shoot = async (file, colorScheme, url, act = async () => {}) => {
    const page = await browser.newPage({ viewport: { width: 480, height: 300 }, deviceScaleFactor: 2, colorScheme })
    await page.goto(url)
    await act(page)
    await page.screenshot({ path: `${DIR}/${file}`, fullPage: true })
    await page.close()
    console.log(`wrote ${DIR}/${file}`)
  }

  await shoot('login-light.png', 'light', authorize(18101, 'my-app'), (p) => signInForm(p, 'alice', 'azure-like'))
  await shoot('login-dark.png', 'dark', authorize(18101, 'my-app'), (p) => signInForm(p, 'alice', 'admin'))
  await shoot('entra-gate.png', 'light', authorize(18104, 'my-app'), (p) => signInForm(p, 'alice', 'admin'))
  await shoot('home.png', 'light', 'http://localhost:18102/')
  await browser.close()
} finally {
  for (const child of children) child.kill()
}
