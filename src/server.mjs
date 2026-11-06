#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  authFromEnv,
  createApp,
  isAuthorized,
} from '@dscpln/server-kit'
import { Daemon } from './pipelines/src/daemon.js'
import { ApiServer } from './pipelines/src/api/index.js'
import { JobEngine } from './jobs/engine.mjs'
import { metaPath } from './jobs/meta.mjs'
import { taskMetaFileFor } from './tasks/task-meta.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BUNDLED_STATIC = path.join(ROOT, 'static')

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

  const pipelineConfig = options.pipelineConfig
    ?? process.env.FL0W_PIPELINES_CONFIG
    ?? path.join(configRoot, 'apps', 'file-pipelines', 'config.json')
  const pipelineDaemon = new Daemon(pipelineConfig, {
    serveApi: false,
    force: options.force,
    bindHost: '127.0.0.1',
    port: 0,
  })
  await pipelineDaemon.start()

  const engine = new JobEngine({
    taskServer,
    pipelineDaemon,
    configRoot,
    stateDir: process.env.BACKUPCTL_STATE_DIR,
    metaFile: metaPath(path.dirname(process.env.BACKUPCTL_CONFIG_FILE)),
    legacyMetaFile: taskMetaFileFor(process.env.BACKUPCTL_CONFIG_FILE),
    log,
  })
  await engine.start()
  pipelineDaemon.onConfigChange = () => {
    engine.reload().catch((err) => log(`job reload failed: ${err.message}`))
  }

  // The unified UI covers tasks and pipelines; only their APIs remain mounted.
  const taskApp = taskServer.createApp({ basePath: '', staticDir: null })
  const pipelineApp = new ApiServer(pipelineDaemon, { basePath: '', staticDir: null }).createApp()

  const app = createApp({
    title: 'Jobs',
    brand: 'FL0W',
    basePath: '',
    staticDir: BUNDLED_STATIC,
    jsonBody: false,
    healthExtra: () => engine.health(),
    routes: (router) => {
      router.use('/api', engine.router())

      router.get('/api/state', (req, res) => {
        const { jobs } = engine.listJobs()
        res.json({
          tasks: jobs.filter((job) => job.type === 'task').length,
          pipelines: jobs.filter((job) => job.type === 'pipeline').length,
          running: jobs.filter((job) => job.running).map((job) => job.id),
          paused: Boolean(pipelineDaemon.config.paused),
          schedules: engine.schedulers.size,
        })
      })

      router.get('/api/metrics', (req, res) => {
        res.type('text/plain; version=0.0.4; charset=utf-8')
        res.send(engine.metricsText())
      })

      // Old view URLs now redirect to the unified job list; their APIs stay
      // mounted for uploads, browser access and pipeline file actions.
      router.get(['/tasks', '/tasks/'], (req, res) => res.redirect(302, '/'))
      router.get(['/pipelines', '/pipelines/'], (req, res) => res.redirect(302, '/'))
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
    engine.stopSchedulers()
    taskServer.stopSchedulers()
    await pipelineDaemon?.stop().catch(() => {})
    await new Promise((resolve) => server.close(resolve))
  }

  log(`FL0W listening on http://${host}:${port}`)
  return { app, server, stop, daemon: pipelineDaemon, taskServer, engine }
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
