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

test('FL0W serves the unified job API and redirects legacy views', async (t) => {
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

  for (const legacy of ['/tasks/', '/pipelines/']) {
    const response = await fetch(`${base}${legacy}`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/')
  }
  // Their APIs stay mounted for uploads, browser access and file actions.
  assert.equal((await fetch(`${base}/tasks/api/health`)).status, 200)
  assert.equal((await fetch(`${base}/pipelines/api/health`)).status, 200)
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

  // Unified run history records task and pipeline runs under the same model.
  const taskRuns = await (await fetch(`${base}/api/jobs/task:Echo/runs`)).json()
  assert.equal(taskRuns.runs.length, 1)
  assert.equal(taskRuns.runs[0].ok, true)
  const pipelineRuns = await (await fetch(`${base}/api/jobs/pipeline:Camera/runs`)).json()
  assert.equal(pipelineRuns.runs.length, 1)
  assert.equal(pipelineRuns.runs[0].trigger, 'manual')

  // Metadata is persisted in one file shared by tasks and pipelines.
  const at = new Date(Date.now() + 2 * 60 * 60 * 1000)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const patched = await fetch(`${base}/api/jobs/task:Echo`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: { enabled: true, days: [], at: hhmm, catchUp: true } }),
  })
  assert.equal(patched.status, 200)
  const patchedJob = await patched.json()
  assert.equal(patchedJob.schedule.enabled, true)
  assert.ok(patchedJob.next_run > Date.now())

  const metaFile = path.join(root, 'jobs-meta.json')
  const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'))
  assert.equal(meta.jobs['task:Echo'].schedule.at, hhmm)
  assert.ok(meta.jobs['pipeline:Camera'])

  const attributes = await (await fetch(`${base}/api/attributes`)).json()
  assert.ok(attributes.attributes.some((attribute) => attribute.name === 'Category'))
  const saved = await fetch(`${base}/api/attributes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes: attributes.attributes, default_group_by: 'Category' }),
  })
  assert.equal(saved.status, 200)
})
