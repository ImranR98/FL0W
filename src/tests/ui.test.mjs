import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launchBrowser } from '@dscpln/test-kit'

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fl0w-ui-test-'))
  for (const dir of ['src', 'dest', 'staging', 'review', 'trash', 'logs', 'state', 'home']) {
    await fsp.mkdir(path.join(root, dir), { recursive: true })
  }
  await fsp.writeFile(path.join(root, 'src', 'hello.txt'), 'hello pipeline\n')
  const taskConfig = path.join(root, 'config.mjs')
  await fsp.writeFile(taskConfig, `export default {
    maindir: ${JSON.stringify(root)},
    config_dir: ${JSON.stringify(root)},
    scriptroot: ${JSON.stringify(path.join(root, 'tools'))},
    groups: [{ name: 'Media and Files', tasks: [{ name: 'Echo', state_dir: ${JSON.stringify(path.join(root, 'state'))}, script: 'echo hello', summary_last_line: true }] }],
  }\n`)
  const pipelineConfig = path.join(root, 'pipelines.json')
  await fsp.writeFile(pipelineConfig, JSON.stringify({
    bindHost: '127.0.0.1',
    port: 0,
    concurrency: 1,
    trashRetentionDays: 30,
    settleSeconds: 0,
    maxAutoRetries: 1,
    stagingDir: path.join(root, 'staging'),
    reviewDir: path.join(root, 'review'),
    trashDir: path.join(root, 'trash'),
    logDir: path.join(root, 'logs'),
    syncLockFile: path.join(root, 'lock.json'),
    folders: [{ name: 'Camera Roll', source: path.join(root, 'src'), destination: path.join(root, 'dest'), method: 'copy', autoProcess: false, cleanup: false }],
  }))
  process.env.BACKUPCTL_CONFIG_FILE = taskConfig
  process.env.BACKUPCTL_STATE_DIR = path.join(root, 'state')
  process.env.BACKUPCTL_TMP_DIR = path.join(root, 'tmp')
  process.env.HOME = path.join(root, 'home')
  const { startFl0w } = await import('../server.mjs')
  const app = await startFl0w({ port: 0, host: '127.0.0.1', pipelineConfig, log: () => {} })
  t.after(async () => {
    await app.stop().catch(() => {})
    await fsp.rm(root, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${app.server.address().port}` }
}

test('ui: unified jobs, pipeline card and detail run history render', async (t) => {
  const browser = await launchBrowser()
  if (!browser) {
    t.skip('chromium not available')
    return
  }
  const { base } = await fixture(t)
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="pipeline-Camera Roll"]')
    assert.equal(await page.title(), 'FL0W ⋅ Jobs')
    assert.match(await page.textContent('h1'), /FL0W/)
    assert.equal(await page.locator('.dropzone').count(), 1)
    assert.equal(await page.locator('[data-testid="task-Echo"]').count(), 1)
    assert.equal(await page.locator('.job-card').count(), 2)
    assert.ok((await page.locator('.global-drop__dropzone').boundingBox()).height < 130)
    const buttonStyles = await page.evaluate(() => {
      const primary = getComputedStyle(document.querySelector('.job-card__actions .btn--primary'))
      const outline = getComputedStyle(document.querySelector('.job-card__actions .btn--outline'))
      return { primary: primary.backgroundColor, outline: outline.backgroundColor, border: outline.borderColor }
    })
    assert.notEqual(buttonStyles.primary, 'rgba(0, 0, 0, 0)')
    assert.equal(buttonStyles.outline, 'rgba(0, 0, 0, 0)')
    assert.notEqual(buttonStyles.border, 'rgba(0, 0, 0, 0)')

    await page.getByTestId('type-filter').selectOption('task')
    assert.equal(await page.locator('[data-testid="pipeline-Camera Roll"]').count(), 0)
    assert.equal(await page.locator('[data-testid="task-Echo"]').count(), 1)
    await page.getByTestId('type-filter').selectOption('all')
    await page.getByTestId('group-toggle-Media and Files').click()
    assert.equal(await page.locator('[data-testid="pipeline-Camera Roll"]').count(), 0)
    await page.getByTestId('group-toggle-Media and Files').click()
    assert.match(await page.locator('[data-testid="job-type-task-Echo"]').textContent(), /Task · Command/)
    assert.match(await page.locator('[data-testid="job-type-pipeline-Camera Roll"]').textContent(), /Pipeline · Copy/)
    assert.equal(await page.locator('[data-testid="pipeline-Camera Roll"]').getByRole('button', { name: 'Settings' }).count(), 1)
    assert.equal(await page.locator('[data-testid="task-Echo"]').getByRole('button', { name: 'Settings' }).count(), 1)
    assert.ok(await page.locator('[data-testid="pipeline-Camera Roll"] .btn').count() >= 4)

    await page.locator('[data-testid="pipeline-Camera Roll"]').getByRole('button', { name: 'Settings' }).click()
    await page.waitForSelector('dialog[open]')
    assert.match(await page.locator('dialog[open] h2').first().textContent(), /Settings: Camera Roll/)
    assert.equal(await page.locator('dialog[open] #job-attribute-Category').count(), 1)
    assert.equal(await page.locator('dialog[open] [id="job-attribute-Best run from"]').count(), 1)
    assert.match(await page.locator('[id="job-attribute-Best run from"]').textContent(), /Anywhere \(auto\)/)
    await page.selectOption('[id="job-attribute-Best run from"]', '')
    await page.locator('dialog[open]').getByRole('button', { name: 'Save settings' }).click()
    await page.waitForSelector('dialog[open]', { state: 'detached' })
    await page.waitForFunction(() => !document.querySelector('[data-testid="pipeline-Camera Roll"]')?.innerText.includes('Best run from'))

    await page.locator('[data-testid="pipeline-Camera Roll"]').getByRole('button', { name: 'Files' }).click()
    await page.waitForSelector('text=Run history')
    assert.match(page.url(), /#\/jobs\/pipeline\/Camera%20Roll$/)
    assert.match(await page.textContent('body'), /Camera Roll/)
    assert.match(await page.textContent('body'), /Run history/)
    assert.deepEqual(errors, [])
    await page.close()
  } finally {
    await browser.close()
  }
})
