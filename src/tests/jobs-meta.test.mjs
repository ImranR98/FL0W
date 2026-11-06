import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadMeta } from '../jobs/meta.mjs'

test('jobs-meta migrates task-meta once and ignores it afterwards', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fl0w-jobs-meta-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'jobs-meta.json')
  const legacyFile = path.join(root, 'task-meta.json')
  const legacy = {
    version: 1,
    attributes: [
      { name: 'Category', values: ['G'] },
      { name: 'Best run from', values: ['PC'] },
    ],
    default_group_by: 'Category',
    tasks: {
      Echo: {
        attributes: { Category: 'G', 'Best run from': 'PC' },
        schedule: { enabled: true, days: [1], at: '06:15', catchUp: false },
      },
    },
  }
  await fsp.writeFile(legacyFile, JSON.stringify(legacy))

  const first = loadMeta({
    file,
    legacyFile,
    tasks: [{ name: 'Echo', group: 'G' }],
    folders: [],
  })
  assert.equal(first.jobs['task:Echo'].attributes.Category, 'G')
  assert.equal(first.jobs['task:Echo'].schedule.at, '06:15')
  await fsp.access(file)

  await fsp.writeFile(legacyFile, JSON.stringify({
    ...legacy,
    tasks: { Echo: { attributes: { Category: 'Changed' } } },
  }))
  const second = loadMeta({
    file,
    legacyFile,
    tasks: [{ name: 'Echo', group: 'G' }],
    folders: [],
  })
  assert.equal(second.jobs['task:Echo'].attributes.Category, 'G')
})
