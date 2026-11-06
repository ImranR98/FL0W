#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  authFromEnv,
  createApp,
  isAuthorized,
  normalizeSpec,
  occurrenceAfter,
  Scheduler,
} from '@dscpln/server-kit'
import { Daemon } from './pipelines/src/daemon.js'
import { ApiServer } from './pipelines/src/api/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BUNDLED_STATIC = path.join(ROOT, 'static')
const TASK_STATIC = path.join(HERE, 'tasks', 'static')
const PIPELINE_STATIC = path.join(HERE, 'pipelines', 'static')

// Defaults are applied before importing the task modules: their state/config
// constants are computed at module load. Config and state live in the
// gitignored config/ clone, matching the other apps.
const configRoot = path.join(ROOT, 'config')
process.env.BACKUPCTL_CONFIG_FILE ??= process.env.FL0W_CONFIG ?? path.join(configRoot, 'config.mjs')
process.env.BACKUPCTL_STATE_DIR ??= process.env.FL0W_STATE_DIR ?? path.join(configRoot, '.state')
process.env.BACKUPCTL_TMP_DIR ??= process.env.FL0W_TMP_DIR ?? path.join(configRoot, '.tmp')
process.env.BACKUPCTL_REPO_DIR ??= ROOT
process.env.NOTIFY_RELAY_URL ??= process.env.DSCPLN_PORTAL_URL

const taskServer = await import('./tasks/server.mjs')

const PIPELINE_SCHEDULERS = new Map()
let pipelineDaemon = null

function folderAttributes(folder) {
  return folder.def.attributes ?? { Category: folder.def.category ?? 'Pipelines' }
}

function pipelineJob(folder) {
  const def = folder.def
  const counts = {}
  for (const file of folder.files.values()) counts[file.status] = (counts[file.status] ?? 0) + 1
  const pending = (counts.pending ?? 0) + (counts.queued ?? 0) + (counts.processing ?? 0)
  const review = counts.review ?? 0
  const errors = (counts.error ?? 0) + (counts.conflict ?? 0)
  const running = Boolean(pipelineDaemon?.queue.active.has(def.name))
  const schedule = def.schedule ? normalizeSpec(def.schedule) : null
  const lastEventAt = folder.lastEventAt || 0
  const state = lastEventAt
    ? {
        ts: lastEventAt / 1000,
        ok: errors === 0,
        summary: `${pending} pending · ${review} review · ${errors} issue${errors === 1 ? '' : 's'}`,
        last_run_text: `${errors ? 'Issues' : 'OK'} · ${taskServer.humanAgo(lastEventAt / 1000)}`,
      }
    : null
  return {
    type: 'pipeline',
    kind: 'pipeline',
    name: def.name,
    group: def.category ?? 'Pipelines',
    note: def.method,
    method: def.method,
    source: def.source,
    destination: def.destination,
    placement: def.placement,
    cleanup: def.cleanup,
    exists: folder.exists,
    avail: folder.exists,
    avail_reason: folder.exists ? '' : 'Source directory is unavailable',
    attributes: folderAttributes(folder),
    schedule,
    next_run: schedule?.enabled ? occurrenceAfter(schedule, new Date()) : null,
    schedule_missed: 0,
    notify: def.notify === 'errors' ? 'errors' : 'always',
    running,
    queued: false,
    pill: running ? 'running' : errors ? 'fail' : pending ? 'warn' : 'neutral',
    state,
    counts,
    pending,
    review,
    errors,
    fileCount: folder.files.size,
    last_event_at: lastEventAt,
    uploads: false,
    prompts: [],
    actions: [],
    schedulable: true,
  }
}

function allJobs() {
  const tasks = taskServer.TASK_LIST.map((task) => ({ ...taskServer.taskJson(task), type: 'task', kind: 'task' }))
  const pipelines = pipelineDaemon
    ? pipelineDaemon.store.listFolders().map(pipelineJob)
    : []
  return { tasks, pipelines, jobs: [...tasks, ...pipelines] }
}

function stopPipelineSchedulers() {
  for (const scheduler of PIPELINE_SCHEDULERS.values()) scheduler.stop()
  PIPELINE_SCHEDULERS.clear()
}

function startPipelineSchedulers() {
  stopPipelineSchedulers()
  if (!pipelineDaemon) return
  for (const folder of pipelineDaemon.store.listFolders()) {
    const spec = normalizeSpec(folder.def.schedule)
    if (!spec.enabled) continue
    const name = folder.def.name
    const store = taskServer.scheduleStore(`pipeline:${name}`)
    const scheduler = new Scheduler({
      getSpec: () => folder.def.schedule,
      onDue: async () => {
        const result = await pipelineDaemon.queue.processNow(name)
        if (!result.ok) console.warn(`[schedule] pipeline ${name}: ${result.error ?? 'not started'}`)
      },
      isBusy: () => pipelineDaemon.queue.active.has(name),
      onMissed: () => store.markMissed(),
      store,
      log: (line) => console.log(`[schedule] pipeline ${name}: ${line}`),
    })
    scheduler.start()
    PIPELINE_SCHEDULERS.set(name, scheduler)
  }
  if (PIPELINE_SCHEDULERS.size) {
    console.log(`Pipeline schedules enabled: ${[...PIPELINE_SCHEDULERS.keys()].join(', ')}`)
  }
}

function pipelineLog(name, limit = 200) {
  if (!pipelineDaemon) return ''
  const lines = pipelineDaemon.log.recent(limit)
  const needle = String(name).toLowerCase()
  return lines.filter((line) => line.toLowerCase().includes(needle)).join('\n') || lines.join('\n')
}

function metricsExtra() {
  if (!pipelineDaemon) return ''
  const snapshot = pipelineDaemon.store.snapshot()
  const lines = [
    '# HELP fl0w_pipeline_count Configured pipeline jobs',
    '# TYPE fl0w_pipeline_count gauge',
    `fl0w_pipeline_count ${snapshot.folders.length}`,
  ]
  for (const folder of snapshot.folders) {
    const labels = `pipeline="${String(folder.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    const pending = (folder.counts.pending ?? 0) + (folder.counts.queued ?? 0)
    const errors = (folder.counts.error ?? 0) + (folder.counts.conflict ?? 0)
    lines.push(`fl0w_pipeline_pending{${labels}} ${pending}`)
    lines.push(`fl0w_pipeline_errors{${labels}} ${errors}`)
    lines.push(`fl0w_pipeline_review{${labels}} ${folder.counts.review ?? 0}`)
  }
  return `${lines.join('\n')}\n`
}

export async function startFl0w(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8085)
  const host = options.host ?? process.env.HOST ?? '0.0.0.0'
  const log = options.log ?? ((line) => console.log(line))

  await taskServer.boot()
  try {
    taskServer.ensureRuntimeDirs()
  } catch (err) {
    log(`Could not prepare task runtime directories: ${err.message}`)
    throw err
  }
  taskServer.startSchedulers()

  const pipelineConfig = options.pipelineConfig
    ?? process.env.FL0W_PIPELINES_CONFIG
    ?? path.join(configRoot, 'apps', 'file-pipelines', 'config.json')
  pipelineDaemon = new Daemon(pipelineConfig, {
    serveApi: false,
    force: options.force,
    bindHost: '127.0.0.1',
    port: 0,
  })
  await pipelineDaemon.start()
  pipelineDaemon.onConfigChange = startPipelineSchedulers
  startPipelineSchedulers()

  const taskApp = taskServer.createApp({
    basePath: '',
    htmlBasePath: '/tasks',
    staticDir: fs.existsSync(path.join(TASK_STATIC, 'index.html')) ? TASK_STATIC : null,
  })
  const pipelineApp = new ApiServer(pipelineDaemon, {
    basePath: '',
    htmlBasePath: '/pipelines',
    staticDir: fs.existsSync(path.join(PIPELINE_STATIC, 'index.html')) ? PIPELINE_STATIC : null,
  }).createApp()

  const app = createApp({
    title: 'Jobs',
    brand: 'FL0W',
    basePath: '',
    staticDir: BUNDLED_STATIC,
    healthExtra: () => {
      const { tasks, pipelines } = allJobs()
      return {
        tasks: tasks.length,
        pipelines: pipelines.length,
        missingConfig: taskServer.MISSING_CONFIG,
        schedules: taskServer.TASK_LIST.filter((task) => task.schedule?.enabled).length + PIPELINE_SCHEDULERS.size,
        browser: Boolean(process.env.BROWSER_REMOTE),
      }
    },
    routes: (router) => {
      // Unified job API. Task and pipeline engines stay behind their existing
      // APIs; this is the single model the UI and DA5H consume.
      router.get('/api/jobs', (req, res) => {
        const { jobs } = allJobs()
        res.json({
          jobs,
          attributes: taskServer.LOCAL.attributes ?? [],
          default_group_by: taskServer.LOCAL.default_group_by ?? 'Category',
          missing_config: taskServer.MISSING_CONFIG,
        })
      })

      router.post('/api/jobs/:name/run', async (req, res) => {
        const name = req.params.name
        const task = taskServer.TASK_MAP.get(name)
        if (task) {
          if (taskServer.RUNS.has(name)) return res.status(409).json({ error: 'This job is already running' })
          const [avail, reason] = taskServer.availability(task, taskServer.LOCAL)
          if (!avail) return res.status(400).json({ error: reason })
          taskServer.startRun(name, req.body ?? {})
          return res.json({ started: true, type: 'task' })
        }
        const folder = pipelineDaemon?.store.getFolder(name)
        if (!folder) return res.status(404).json({ error: 'Unknown job' })
        const result = await pipelineDaemon.queue.processNow(name, { files: req.body?.files })
        return res.status(result.ok ? 200 : 409).json({ ...result, type: 'pipeline' })
      })

      router.post('/api/jobs/:name/cancel', (req, res) => {
        const name = req.params.name
        const result = taskServer.cancelRun(name)
        if (!result) return res.status(409).json({ error: 'Job is not running' })
        res.json(result)
      })

      router.get('/api/jobs/:name/log', (req, res) => {
        const name = req.params.name
        const task = taskServer.TASK_MAP.get(name)
        if (task) return res.json({ output: taskServer.loadTaskState(task, taskServer.LOCAL)?.output ?? '' })
        if (pipelineDaemon?.store.getFolder(name)) return res.json({ output: pipelineLog(name) })
        res.status(404).json({ error: 'Unknown job' })
      })

      router.get('/api/state', (req, res) => {
        const { tasks, pipelines } = allJobs()
        res.json({
          tasks: tasks.length,
          pipelines: pipelines.length,
          running: [...tasks, ...pipelines].filter((job) => job.running).map((job) => job.name),
          paused: Boolean(pipelineDaemon?.config.paused),
          schedules: taskServer.TASK_LIST.filter((task) => task.schedule?.enabled).length + PIPELINE_SCHEDULERS.size,
        })
      })

      router.get('/api/metrics', (req, res) => {
        res.type('text/plain; version=0.0.4; charset=utf-8')
        res.send(taskServer.metricsText() + metricsExtra())
      })

      router.use('/tasks', taskApp)
      router.use('/pipelines', pipelineApp)
    },
    log,
  })

  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening))
    listening.once('error', reject)
  })
  taskServer.configureServer(server)
  if (process.env.BROWSER_REMOTE) {
    const authConfig = authFromEnv()
    taskServer.attachBrowserWebSocket(server, '/tasks', process.env.BROWSER_REMOTE, {
      isAuthorized: authConfig ? (req) => isAuthorized(req, authConfig) : null,
    })
  }

  const stop = async () => {
    taskServer.stopSchedulers()
    stopPipelineSchedulers()
    await pipelineDaemon?.stop().catch(() => {})
    await new Promise((resolve) => server.close(resolve))
  }

  log(`FL0W listening on http://${host}:${port}`)
  return { app, server, stop, daemon: pipelineDaemon, taskServer }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fl0w = await startFl0w()
  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    console.log(`received ${signal}, shutting down...`)
    await fl0w.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
