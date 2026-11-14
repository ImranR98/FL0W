// Unified Job engine. The task runner and pipeline runtime remain executors;
// this layer owns job identity, metadata, schedules, run history, notifications
// and the HTTP/UI contract.

import express from 'express'
import { asyncRoute, Notifier, occurrenceAfter, Scheduler } from '@dscpln/server-kit'
import {
  jobId,
  loadMeta,
  metaPath,
  parseJobId,
  patchEntry,
  saveAttributes as applyAttributes,
  withUsedAttributes,
  writeMeta,
} from './meta.mjs'
import { RunStoreSet } from './runs.mjs'

const DAY_SECONDS = 24 * 60 * 60
const SCHEDULES_ENABLED = process.env.BACKUPCTL_SCHEDULES !== '0'

function countFiles(folder) {
  const counts = {}
  for (const file of folder.files.values()) counts[file.status] = (counts[file.status] ?? 0) + 1
  const pending = (counts.pending ?? 0) + (counts.queued ?? 0) + (counts.processing ?? 0)
  const review = counts.review ?? 0
  const errors = (counts.error ?? 0) + (counts.conflict ?? 0)
  return { counts, pending, review, errors }
}

export class JobEngine {
  constructor({ taskServer, pipelineDaemon, configRoot, stateDir, metaFile, legacyMetaFile, log = console.log }) {
    this.taskServer = taskServer
    this.daemon = pipelineDaemon
    this.configRoot = configRoot
    this.stateDir = stateDir
    this.metaFile = metaFile ?? metaPath(configRoot)
    this.legacyMetaFile = legacyMetaFile
    this.logger = log
    this.meta = null
    this.runs = new RunStoreSet(stateDir)
    this.schedulers = new Map()
    this.pipelineStarts = new Map()
    this.pipelineTriggers = new Map()
    this.pendingPipelineTrigger = new Map()
  }

  async start() {
    await this.reload()
    this.daemon.ctx.onJobStart = (name, meta) => this.#pipelineStart(name, meta)
    this.daemon.ctx.onJobEnd = (name, stats) => this.#pipelineEnd(name, stats)
    this.startSchedulers()
    return this
  }

  async reload() {
    const folders = this.daemon.store.listFolders()
    this.meta = loadMeta({
      file: this.metaFile,
      legacyFile: this.legacyMetaFile,
      tasks: this.taskServer.TASK_LIST,
      folders,
    })
    await this.runs.load(this.jobIds())
    this.startSchedulers()
  }

  jobIds() {
    return [
      ...this.taskServer.TASK_LIST.map((task) => jobId('task', task.name)),
      ...this.daemon.store.listFolders().map((folder) => jobId('pipeline', folder.def.name)),
    ]
  }

  #jobEntry(id) {
    return this.meta.jobs[id] ?? { attributes: {}, schedule: null, notify: 'never', enabled: true }
  }

  #task(id) {
    const parsed = parseJobId(id)
    return parsed?.kind === 'task' ? this.taskServer.TASK_MAP.get(parsed.name) ?? null : null
  }

  #pipeline(id) {
    const parsed = parseJobId(id)
    return parsed?.kind === 'pipeline' ? this.daemon.store.getFolder(parsed.name) : null
  }

  #runSnapshot(id) {
    return this.runs.snapshot(id)
  }

  #lastRun(id) {
    return this.#runSnapshot(id).lastRun
  }

  #stateFor(id, fallback = null) {
    const last = this.#lastRun(id)
    if (!last) return fallback === 'fail' ? 'danger' : fallback
    return {
      ts: last.endedAt / 1000,
      ok: Boolean(last.ok),
      summary: last.summary ?? '',
      last_run_text: `${last.ok ? 'OK' : 'FAILED'} · ${this.taskServer.humanAgo(last.endedAt / 1000)}`,
    }
  }

  #pill(id, running, fallback = 'neutral') {
    if (running) return 'running'
    const last = this.#lastRun(id)
    if (!last) return fallback === 'fail' ? 'danger' : fallback
    if (!last.ok) return 'danger'
    return Date.now() / 1000 - last.endedAt / 1000 < DAY_SECONDS ? 'ok' : 'neutral'
  }

  #schedulable(id) {
    const entry = this.#jobEntry(id)
    if (!entry.enabled) return false
    const task = this.#task(id)
    if (task) return this.taskServer.isSchedulable(task)
    const folder = this.#pipeline(id)
    return Boolean(folder) && folder.def.method !== 'reviewed-audio'
  }

  #nextRun(id) {
    const scheduler = this.schedulers.get(id)
    if (scheduler) return scheduler.nextRunAt()
    const schedule = this.#jobEntry(id).schedule
    return schedule?.enabled ? occurrenceAfter(schedule, new Date()) : null
  }

  taskJob(task) {
    const id = jobId('task', task.name)
    const entry = this.#jobEntry(id)
    const t = this.taskServer.taskJson(task)
    const state = this.#stateFor(id, t.state)
    const running = Boolean(this.taskServer.RUNS.has(task.name))
    const pill = this.#pill(id, running, t.pill)
    return {
      ...t,
      id,
      type: 'task',
      kind: 'task',
      subtype: task.webhook ? 'webhook' : 'command',
      attributes: { ...entry.attributes },
      schedule: entry.schedule,
      next_run: this.#nextRun(id),
      schedule_missed: this.#runSnapshot(id).missed ?? 0,
      last_scheduled_run: this.#runSnapshot(id).lastScheduledRun ?? null,
      notify: entry.notify,
      enabled: entry.enabled,
      state,
      pill,
      running,
      schedulable: this.#schedulable(id),
      capabilities: {
        run: entry.enabled,
        cancel: true,
        uploads: t.uploads,
        prompts: Boolean(t.prompts?.length),
        schedule: this.#schedulable(id),
        detail: 'task',
        settings: 'task',
      },
    }
  }

  pipelineJob(folder) {
    const def = folder.def
    const id = jobId('pipeline', def.name)
    const entry = this.#jobEntry(id)
    const { counts, pending, review, errors } = countFiles(folder)
    const running = Boolean(this.daemon.queue.active.has(def.name))
    const state = this.#stateFor(id, null)
    const schedulable = this.#schedulable(id)
    return {
      id,
      type: 'pipeline',
      kind: 'pipeline',
      subtype: def.method,
      name: def.name,
      group: entry.attributes?.Category ?? 'Media and Files',
      note: def.method,
      method: def.method,
      source: def.source,
      destination: def.destination,
      placement: def.placement,
      cleanup: def.cleanup,
      exists: folder.exists,
      avail: folder.exists,
      avail_reason: folder.exists ? '' : 'Source directory is unavailable',
      attributes: { ...entry.attributes },
      schedule: entry.schedule,
      next_run: this.#nextRun(id),
      schedule_missed: this.#runSnapshot(id).missed ?? 0,
      last_scheduled_run: this.#runSnapshot(id).lastScheduledRun ?? null,
      notify: entry.notify,
      enabled: entry.enabled,
      running,
      queued: false,
      pill: this.#pill(id, running, errors ? 'danger' : pending ? 'warn' : 'neutral'),
      state,
      counts,
      pending,
      review,
      errors,
      // Progress is over considered files: ignored and already-cleaned
      // entries must not make the completion percentage drop after a cleanup.
      fileCount: Math.max(0, folder.files.size - (counts.ignored ?? 0) - (counts.cleaned ?? 0)),
      last_event_at: folder.lastEventAt,
      uploads: false,
      prompts: [],
      actions: [],
      schedulable,
      capabilities: {
        run: entry.enabled,
        cancel: false,
        uploads: false,
        prompts: false,
        schedule: schedulable,
        detail: 'pipeline',
        settings: 'pipeline',
      },
    }
  }

  listJobs() {
    const tasks = this.taskServer.TASK_LIST.map((task) => this.taskJob(task))
    const pipelines = this.daemon.store.listFolders().map((folder) => this.pipelineJob(folder))
    return { tasks, pipelines, jobs: [...tasks, ...pipelines] }
  }

  getJob(id) {
    const task = this.#task(id)
    if (task) return this.taskJob(task)
    const folder = this.#pipeline(id)
    if (folder) return this.pipelineJob(folder)
    // Transitional convenience for old clients: accept a bare unique name.
    if (!String(id).includes(':')) {
      const matches = this.listJobs().jobs.filter((job) => job.name === id)
      if (matches.length === 1) return matches[0]
    }
    return null
  }

  attributes() {
    const { jobs } = this.listJobs()
    return {
      attributes: withUsedAttributes(this.meta, jobs),
      default_group_by: this.meta.default_group_by,
    }
  }

  async saveAttributes(raw, defaultGroupBy) {
    const next = applyAttributes(this.meta, raw, defaultGroupBy)
    writeMeta(this.metaFile, next)
    await this.reload()
    return this.attributes()
  }

  async updateJob(id, patch = {}) {
    const job = this.getJob(id)
    if (!job) {
      const err = new Error('Unknown job')
      err.statusCode = 404
      throw err
    }
    const resolved = job.id
    const next = patchEntry(this.meta, resolved, patch)
    const entry = next.jobs[resolved]
    const task = this.#task(resolved)
    const folder = this.#pipeline(resolved)
    const canSchedule = task ? this.taskServer.isSchedulable(task) : folder?.def.method !== 'reviewed-audio'
    if (entry.schedule?.enabled && !canSchedule) {
      const err = new Error('This job cannot be scheduled')
      err.statusCode = 400
      throw err
    }
    writeMeta(this.metaFile, next)
    await this.reload()
    return this.getJob(resolved)
  }

  async run(id, { trigger = 'manual', body = {} } = {}) {
    const resolved = this.getJob(id)?.id ?? id
    const task = this.#task(resolved)
    if (task) {
      if (!this.#jobEntry(resolved).enabled) return { status: 409, body: { error: 'Job is disabled' } }
      const result = this.taskServer.requestTaskRun(task.name, body, {
        trigger,
        notify: false,
        onFinish: (run) => {
          this.#finishRun(resolved, run).catch((err) => this.logger(`run record failed: ${err.message}`))
        },
      })
      return { status: result.status, body: { ...result.body, type: 'task' } }
    }
    const folder = this.#pipeline(resolved)
    if (folder) {
      if (!this.#jobEntry(resolved).enabled) return { status: 409, body: { error: 'Job is disabled' } }
      if (trigger === 'schedule' && this.daemon.config.paused) {
        await this.runs.markMissed(resolved)
        return { status: 409, body: { error: 'Pipeline processing is paused' } }
      }
      this.pendingPipelineTrigger.set(folder.def.name, trigger)
      const result = await this.daemon.queue.processNow(folder.def.name, { files: body?.files })
      if (!result.ok) {
        this.pendingPipelineTrigger.delete(folder.def.name)
        return { status: result.busy ? 409 : 400, body: { ...result, type: 'pipeline' } }
      }
      if (!result.processed && !this.daemon.queue.active.has(folder.def.name)) {
        this.pendingPipelineTrigger.delete(folder.def.name)
        const now = Date.now()
        await this.#finishRun(resolved, {
          ok: true,
          summary: 'No files to process',
          startedAt: now,
          endedAt: now,
          durationSec: 0,
          trigger,
        })
      }
      return { status: 200, body: { ...result, type: 'pipeline' } }
    }
    const err = new Error('Unknown job')
    err.statusCode = 404
    throw err
  }

  cancel(id) {
    const task = this.#task(this.getJob(id)?.id ?? id)
    if (!task) return { status: 409, body: { error: 'Cancelling a pipeline job is not supported' } }
    const result = this.taskServer.cancelRun(task.name)
    return result ? { status: 200, body: result } : { status: 409, body: { error: 'Job is not running' } }
  }

  log(id, limit = 200) {
    const resolved = this.getJob(id)?.id ?? id
    const task = this.#task(resolved)
    if (task) return this.taskServer.loadTaskState(task, this.taskServer.LOCAL)?.output ?? ''
    const folder = this.#pipeline(resolved)
    if (!folder) return ''
    const lines = this.daemon.log.recent(limit)
    const needle = folder.def.name.toLowerCase()
    return lines.filter((line) => line.toLowerCase().includes(needle)).join('\n')
  }

  runsFor(id) {
    return this.#runSnapshot(this.getJob(id)?.id ?? id).history ?? []
  }

  pipelineDetail(id) {
    const folder = this.#pipeline(this.getJob(id)?.id ?? id)
    if (!folder) return null
    const snapshot = this.daemon.store.snapshot()
    const detail = snapshot.folders.find((entry) => entry.name === folder.def.name) ?? null
    return detail
  }

  async #finishRun(id, run) {
    const entry = this.#jobEntry(id)
    await this.runs.record(id, run)
    // Pipeline runs notify per file (coalesced by the pipeline notifier). A
    // job-level summary here would duplicate those messages.
    if (this.#pipeline(id)) return
    if (entry.notify === 'never') return
    if (run.ok && entry.notify !== 'always') return
    const relayUrl = String(process.env.NOTIFY_RELAY_URL ?? '').trim()
    if (!relayUrl) return
    const job = this.getJob(id)
    const origin = String(process.env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '')
    const notifier = new Notifier({
      app: job?.name ?? id,
      brand: 'FL0W',
      relayUrl,
      notifySuccess: true,
      click: origin ? `${origin}/#/jobs/${encodeURIComponent(id)}` : '',
    }, (line) => this.logger(line))
    await notifier.notifyResult({ ok: run.ok, app: job?.name ?? id, summary: run.summary })
  }

  #pipelineStart(name, meta = {}) {
    const folder = this.daemon.store.getFolder(name)
    if (!folder) return
    const id = jobId('pipeline', name)
    const startedAt = Date.now()
    const trigger = meta?.trigger ?? this.pendingPipelineTrigger.get(name) ?? 'watch'
    this.pipelineStarts.set(name, startedAt)
    this.pipelineTriggers.set(name, trigger)
    this.runs.begin(id, { startedAt, trigger }).catch((err) => this.logger(`pipeline begin failed: ${err.message}`))
  }

  #pipelineEnd(name, stats) {
    const folder = this.daemon.store.getFolder(name)
    if (!folder) return
    const id = jobId('pipeline', name)
    const startedAt = this.pipelineStarts.get(name) ?? Date.now()
    const trigger = this.pipelineTriggers.get(name) ?? 'watch'
    const runStats = stats ?? { processed: 0, review: 0, issues: 0 }
    const summary = [
      `${runStats.processed} processed`,
      runStats.review ? `${runStats.review} awaiting review` : null,
      `${runStats.issues} issue${runStats.issues === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ')
    this.pipelineStarts.delete(name)
    this.pipelineTriggers.delete(name)
    this.pendingPipelineTrigger.delete(name)
    const endedAt = Date.now()
    this.#finishRun(id, {
      ok: runStats.issues === 0,
      summary,
      startedAt,
      endedAt,
      durationSec: Math.max(0, (endedAt - startedAt) / 1000),
      trigger,
    }).catch((err) => this.logger(`pipeline finish failed: ${err.message}`))
  }

  isRunning(id) {
    const task = this.#task(id)
    if (task) return this.taskServer.RUNS.has(task.name) || this.taskServer.isQueued(task.name, task.serial_key)
    const folder = this.#pipeline(id)
    return Boolean(folder && this.daemon.queue.active.has(folder.def.name))
  }

  startSchedulers() {
    this.stopSchedulers()
    if (!SCHEDULES_ENABLED) return
    for (const job of this.listJobs().jobs) {
      const id = job.id
      const entry = this.#jobEntry(id)
      if (!entry.schedule?.enabled || !entry.enabled || !job.schedulable) continue
      const task = this.#task(id)
      if (task && task.host !== 'any' && task.host !== this.taskServer.instanceHost()) continue
      const scheduler = new Scheduler({
        getSpec: () => this.#jobEntry(id).schedule,
        onDue: () => this.run(id, { trigger: 'schedule' }),
        isBusy: () => this.isRunning(id),
        onMissed: () => this.runs.markMissed(id),
        store: this.runs.schedulerStore(id),
        log: (line) => this.logger(`[schedule] ${id}: ${line}`),
      })
      scheduler.start()
      this.schedulers.set(id, scheduler)
    }
    if (this.schedulers.size) this.logger(`Schedules enabled: ${[...this.schedulers.keys()].join(', ')}`)
  }

  stopSchedulers() {
    for (const scheduler of this.schedulers.values()) scheduler.stop()
    this.schedulers.clear()
  }

  health() {
    return {
      tasks: this.taskServer.TASK_LIST.length,
      pipelines: this.daemon.store.listFolders().length,
      missingConfig: this.taskServer.MISSING_CONFIG,
      schedules: this.schedulers.size,
      browser: Boolean(process.env.BROWSER_REMOTE),
    }
  }

  metricsText() {
    const lines = [this.taskServer.metricsText().trimEnd()]
    lines.push('# HELP fl0w_pipeline_count Configured pipeline jobs')
    lines.push('# TYPE fl0w_pipeline_count gauge')
    lines.push(`fl0w_pipeline_count ${this.daemon.store.listFolders().length}`)
    for (const folder of this.daemon.store.listFolders()) {
      const { counts, pending, errors } = countFiles(folder)
      const labels = `pipeline="${String(folder.def.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
      lines.push(`fl0w_pipeline_pending{${labels}} ${pending}`)
      lines.push(`fl0w_pipeline_errors{${labels}} ${errors}`)
      lines.push(`fl0w_pipeline_review{${labels}} ${counts.review ?? 0}`)
    }
    return `${lines.join('\n')}\n`
  }

  router() {
    const router = express.Router()
    router.use(express.json({ limit: '1mb' }))

    router.get('/jobs', (req, res) => {
      const { jobs } = this.listJobs()
      const { attributes, default_group_by } = this.attributes()
      res.json({
        jobs,
        attributes,
        default_group_by,
        missing_config: this.taskServer.MISSING_CONFIG,
        paused: Boolean(this.daemon.config.paused),
        browser: Boolean(process.env.BROWSER_REMOTE),
      })
    })

    router.get('/jobs/:id', (req, res) => {
      const job = this.getJob(req.params.id)
      if (!job) return res.status(404).json({ error: 'Unknown job' })
      res.json(job)
    })

    router.get('/jobs/:id/runs', (req, res) => {
      if (!this.getJob(req.params.id)) return res.status(404).json({ error: 'Unknown job' })
      res.json({ runs: this.runsFor(req.params.id) })
    })

    router.get('/jobs/:id/log', (req, res) => {
      if (!this.getJob(req.params.id)) return res.status(404).json({ error: 'Unknown job' })
      res.json({ output: this.log(req.params.id, Number(req.query.limit ?? 500)) })
    })

    router.get('/jobs/:id/pipeline', (req, res) => {
      const detail = this.pipelineDetail(req.params.id)
      if (!detail) return res.status(404).json({ error: 'Unknown pipeline job' })
      res.json(detail)
    })

    router.post('/jobs/:id/run', asyncRoute(async (req, res) => {
      const result = await this.run(req.params.id, { trigger: 'manual', body: req.body ?? {} })
      res.status(result.status).json(result.body)
    }))

    router.post('/jobs/:id/cancel', (req, res) => {
      const result = this.cancel(req.params.id)
      res.status(result.status).json(result.body)
    })

    router.patch('/jobs/:id', asyncRoute(async (req, res) => {
      const job = await this.updateJob(req.params.id, req.body ?? {})
      res.json(job)
    }))

    router.put('/jobs/:id/settings', asyncRoute(async (req, res) => {
      const job = await this.updateJob(req.params.id, req.body ?? {})
      res.json(job)
    }))

    router.get('/attributes', (req, res) => res.json(this.attributes()))

    router.put('/attributes', asyncRoute(async (req, res) => {
      const body = req.body ?? {}
      const saved = await this.saveAttributes(body.attributes, body.default_group_by)
      res.json(saved)
    }))

    return router
  }
}
