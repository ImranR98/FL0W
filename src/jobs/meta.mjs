// Cross-cutting job metadata. Task commands stay in config.mjs and pipeline
// folder definitions stay in the pipeline JSON; this file is the one
// UI-editable model shared by both: attributes, schedules, notify mode and
// enabled state.

import fs from 'node:fs'
import path from 'node:path'
import { normalizeSpec } from '@dscpln/server-kit'
import {
  attributeDefinitions,
  defaultGroupBy,
  normalizeAttributeDefinitions,
  readTaskMeta,
  writeTaskMeta,
} from '../tasks/task-meta.mjs'

export const META_VERSION = 2
export const ATTRIBUTES = ['Category', 'Best run from']

export const jobId = (kind, name) => `${kind}:${name}`
export const parseJobId = (id) => {
  const value = String(id ?? '')
  const index = value.indexOf(':')
  if (index <= 0) return null
  return { kind: value.slice(0, index), name: value.slice(index + 1) }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function normalizeAttributes(value) {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('job attributes must be an object')
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`attribute '${key}' must be a string`)
    out[key] = entry
  }
  return out
}

function normalizeNotify(value) {
  const mode = String(value ?? 'never').trim().toLowerCase()
  return ['never', 'errors', 'always'].includes(mode) ? mode : 'never'
}

function normalizeEntry(raw = {}) {
  const entry = isObject(raw) ? raw : {}
  const schedule = entry.schedule === undefined ? null : normalizeSpec(entry.schedule)
  return {
    attributes: normalizeAttributes(entry.attributes),
    schedule: schedule?.enabled ? schedule : null,
    notify: normalizeNotify(entry.notify),
    enabled: entry.enabled !== false,
  }
}

export function emptyMeta() {
  return {
    version: META_VERSION,
    attributes: [
      { name: 'Category', values: [] },
      { name: 'Best run from', values: ['Phone', 'Anywhere (auto)', 'Anywhere (manual)', 'PC'] },
    ],
    default_group_by: 'Category',
    jobs: {},
  }
}

function normalizeMeta(raw) {
  const base = emptyMeta()
  const definitions = raw?.attributes?.length
    ? normalizeAttributeDefinitions(raw.attributes)
    : base.attributes
  const jobs = {}
  for (const [id, entry] of Object.entries(isObject(raw?.jobs) ? raw.jobs : {})) {
    if (!parseJobId(id)) continue
    jobs[id] = normalizeEntry(entry)
  }
  return {
    version: META_VERSION,
    attributes: definitions,
    default_group_by: raw?.default_group_by || defaultGroupBy(raw, definitions),
    jobs,
  }
}

function pipelineAttributes(folder) {
  const def = folder.def ?? folder
  const explicit = def.attributes && isObject(def.attributes) ? def.attributes : {}
  // normalizeConfig injects Category: 'Pipelines' as the historic default;
  // treat that exactly like an unset category so the unified default wins.
  const configured = explicit.Category && explicit.Category !== 'Pipelines'
    ? explicit.Category
    : def.category && def.category !== 'Pipelines'
      ? def.category
      : 'Media and Files'
  return {
    ...explicit,
    Category: configured,
    'Best run from': explicit['Best run from'] ?? 'Anywhere (auto)',
  }
}

function migrate({ tasks = [], folders = [], taskMeta }) {
  const groups = [...new Set(tasks.map((task) => task.group).filter(Boolean))]
  const definitions = taskMeta?.attributes?.length
    ? taskMeta.attributes
    : attributeDefinitions([], groups)
  const meta = {
    version: META_VERSION,
    attributes: definitions,
    default_group_by: taskMeta?.default_group_by || defaultGroupBy(taskMeta, definitions),
    jobs: {},
  }
  for (const task of tasks) {
    const old = taskMeta?.tasks?.[task.name] ?? {}
    meta.jobs[jobId('task', task.name)] = normalizeEntry({
      attributes: old.attributes ?? task.attributes ?? { Category: task.group },
      schedule: old.schedule ?? task.schedule ?? null,
      notify: old.notify ?? task.notify ?? 'never',
      enabled: old.enabled !== false,
    })
  }
  for (const folder of folders) {
    const def = folder.def ?? folder
    meta.jobs[jobId('pipeline', def.name)] = normalizeEntry({
      attributes: pipelineAttributes(folder),
      schedule: def.schedule ?? null,
      notify: def.notify === 'errors' ? 'errors' : 'always',
      enabled: def.enabled !== false,
    })
  }
  return normalizeMeta(meta)
}

export function loadMeta({ file, legacyFile, tasks, folders }) {
  if (fs.existsSync(file)) {
    try {
      return normalizeMeta(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (err) {
      throw new Error(`Could not read ${file}: ${err.message}`, { cause: err })
    }
  }
  const taskMeta = legacyFile && fs.existsSync(legacyFile) ? readTaskMeta(legacyFile) : null
  const meta = migrate({ tasks, folders, taskMeta })
  writeMeta(file, meta)
  return meta
}

export function writeMeta(file, meta) {
  writeTaskMeta(file, normalizeMeta(meta))
}

export function withUsedAttributes(meta, jobs) {
  const definitions = meta.attributes.map((attribute) => ({ ...attribute, values: [...attribute.values] }))
  const byName = new Map(definitions.map((attribute) => [attribute.name, attribute]))
  for (const job of jobs) {
    for (const [name, value] of Object.entries(job.attributes ?? {})) {
      if (!value) continue
      let attribute = byName.get(name)
      if (!attribute) {
        attribute = { name, values: [] }
        byName.set(name, attribute)
        definitions.push(attribute)
      }
      if (!attribute.values.includes(value)) attribute.values.push(value)
    }
  }
  return definitions
}

export function patchEntry(meta, id, patch = {}) {
  const next = normalizeMeta(meta)
  const current = next.jobs[id] ?? normalizeEntry()
  const entry = { ...current }
  if (patch.attributes !== undefined) entry.attributes = normalizeAttributes(patch.attributes)
  if (patch.schedule !== undefined) entry.schedule = normalizeSpec(patch.schedule)?.enabled ? normalizeSpec(patch.schedule) : null
  if (patch.notify !== undefined) entry.notify = normalizeNotify(patch.notify)
  if (patch.enabled !== undefined) entry.enabled = patch.enabled !== false
  next.jobs[id] = entry
  return next
}

export function saveAttributes(meta, raw, defaultGroup) {
  const next = normalizeMeta(meta)
  const definitions = normalizeAttributeDefinitions(raw)
  const names = new Set(definitions.map((attribute) => attribute.name))
  if (!names.has('Category')) throw new Error("The built-in 'Category' attribute is required")
  const groupBy = String(defaultGroup ?? '').trim()
  if (groupBy && !names.has(groupBy)) throw new Error(`Default grouping attribute '${groupBy}' does not exist`)
  const valid = new Map(definitions.map((attribute) => [attribute.name, new Set(attribute.values)]))
  const prune = (attributes = {}) => Object.fromEntries(
    Object.entries(attributes).filter(([name, value]) => valid.get(name)?.has(value)),
  )
  for (const entry of Object.values(next.jobs)) entry.attributes = prune(entry.attributes)
  next.attributes = definitions
  next.default_group_by = groupBy || defaultGroupBy({ default_group_by: groupBy }, definitions)
  return next
}

export function metaPath(configRoot, env = process.env) {
  return path.resolve(env.FL0W_JOBS_META ?? path.join(configRoot, 'jobs-meta.json'))
}
