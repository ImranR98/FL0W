import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fl0w-test-'))
  const dirs = ['src', 'dest', 'staging', 'review', 'trash', 'logs', 'state', 'home']
  for (const dir of dirs) await fsp.mkdir(path.join(root, dir), { recursive: true })
  const taskConfig = path.join(root, 'config.mjs')
  await fsp.writeFile(taskConfig, `export default {
    maindir: ${JSON.stringify(root)},
    config_dir: ${JSON.stringify(root)},
    scriptroot: ${JSON.stringify(path.join(root, 'tools'))},
    groups: [{ name: 'Test', tasks: [{ name: 'Echo', state_dir: ${JSON.stringify(path.join(root, 'state'))}, script: 'echo hello from fl0w', summary_last_line: true }] }],
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
    folders: [{ name: 'Camera', source: path.join(root, 'src'), destination: path.join(root, 'dest'), method: 'copy', autoProcess: true, cleanup: false }],
  }))
  process.env.BACKUPCTL_CONFIG_FILE = taskConfig
  process.env.BACKUPCTL_STATE_DIR = path.join(root, 'state')
  process.env.BACKUPCTL_TMP_DIR = path.join(root, 'tmp')
  process.env.HOME = path.join(root, 'home')
  const { startFl0w } = await import('../server.mjs')
  const app = await startFl0w({ port: 0, host: '127.0.0.1', pipelineConfig, log: () => {} })
  const port = app.server.address().port
  t.after(async () => {
    await app.stop().catch(() => {})
    await fsp.rm(root, { recursive: true, force: true })
  })
  return { root, base: `http://127.0.0.1:${port}`, app }
}

test('FL0W serves the unified job API and both legacy views', async (t) => {
  const { base, root } = await fixture(t)
  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.app, 'Jobs')
  assert.equal(health.tasks, 1)
  assert.equal(health.pipelines, 1)

  const jobs = await (await fetch(`${base}/api/jobs`)).json()
  assert.equal(jobs.jobs.length, 2)
  assert.deepEqual(jobs.jobs.map((job) => job.type).sort(), ['pipeline', 'task'])
  assert.equal(jobs.jobs.find((job) => job.type === 'task').name, 'Echo')

  const state = await (await fetch(`${base}/api/state`)).json()
  assert.equal(state.tasks, 1)
  assert.equal(state.pipelines, 1)

  const tasksHtml = await (await fetch(`${base}/tasks/`)).text()
  assert.match(tasksHtml, /<base href="\/tasks\/">/)
  assert.match(tasksHtml, /<title>FL0W ⋅ Tasks<\/title>/)
  const pipelinesHtml = await (await fetch(`${base}/pipelines/`)).text()
  assert.match(pipelinesHtml, /<base href="\/pipelines\/">/)
  assert.match(pipelinesHtml, /<title>FL0W ⋅ Pipelines<\/title>/)
  const rootHtml = await (await fetch(`${base}/`)).text()
  assert.match(rootHtml, /<title>FL0W ⋅ Jobs<\/title>/)

  const run = await fetch(`${base}/api/jobs/Echo/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(run.status, 200)
  let output = ''
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    output = (await (await fetch(`${base}/api/jobs/Echo/log`)).json()).output
    if (output.includes('hello from fl0w')) break
  }
  assert.match(output, /hello from fl0w/)

  await fsp.writeFile(path.join(root, 'src', 'sample.txt'), 'hello pipeline')
  const processed = await fetch(`${base}/api/jobs/Camera/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(processed.status, 200)
})
