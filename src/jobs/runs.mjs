// Unified per-job run history. Pipeline file-level state remains in the
// pipeline store; this records job-level runs only.

import fs from 'node:fs'
import path from 'node:path'
import { stateStore } from '@dscpln/server-kit'

const slug = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')

function handToOwner(file) {
  const uid = Number(process.env.BACKUPCTL_STATE_UID ?? 1000)
  const gid = Number(process.env.BACKUPCTL_STATE_GID ?? uid)
  try {
    fs.chmodSync(file, 0o600)
    fs.chownSync(file, uid, gid)
  } catch {
    // non-root local runs and users without chown
  }
}

export class RunStoreSet {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'jobs')
    this.stores = new Map()
  }

  #store(id) {
    const key = slug(id)
    let store = this.stores.get(key)
    if (!store) {
      const file = path.join(this.dir, `${key}.json`)
      store = stateStore(file)
      const record = store.recordRun
      const begin = store.beginRun
      const missed = store.markMissed
      const scheduled = store.setLastScheduledRun
      store.recordRun = async (entry) => {
        const result = await record(entry)
        handToOwner(file)
        return result
      }
      store.beginRun = async (entry) => {
        const result = await begin(entry)
        handToOwner(file)
        return result
      }
      store.markMissed = async () => {
        const result = await missed()
        handToOwner(file)
        return result
      }
      store.setLastScheduledRun = async (ts) => {
        const result = await scheduled(ts)
        handToOwner(file)
        return result
      }
      this.stores.set(key, store)
    }
    return store
  }

  async load(ids = []) {
    for (const id of ids) await this.#store(id).load()
  }

  get(id) {
    return this.#store(id)
  }

  snapshot(id) {
    return this.#store(id).snapshot()
  }

  async begin(id, entry) {
    return this.#store(id).beginRun(entry)
  }

  async record(id, entry) {
    return this.#store(id).recordRun(entry)
  }

  async markMissed(id) {
    return this.#store(id).markMissed()
  }

  schedulerStore(id) {
    const store = this.#store(id)
    return {
      lastScheduledRun: () => store.lastScheduledRun(),
      setLastScheduledRun: (ts) => store.setLastScheduledRun(ts),
      markMissed: () => store.markMissed(),
    }
  }
}
