import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pause, Play, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { AppHeader, Button, Dropzone, EmptyState, Field, getBrand, getJson, Page, postJson, putJson, showToast, ThemeToggle, Toasts, uploadFile as uploadFileRequest, usePolling } from '@dscpln/ui-kit'
import { pruneTarGz } from '../../src/tasks/ui/src/lib/prune-tar-gz.js'
import AttributesModal from '../../src/tasks/ui/src/components/AttributesModal.jsx'
import ConfirmModal from '../../src/tasks/ui/src/components/modals/ConfirmModal.jsx'
import FieldsModal from '../../src/tasks/ui/src/components/modals/FieldsModal.jsx'
import PickerModal from '../../src/tasks/ui/src/components/modals/PickerModal.jsx'
import ResultModal from '../../src/tasks/ui/src/components/modals/ResultModal.jsx'
import JobCard from './components/JobCard.jsx'
import JobSettingsDialog from './components/JobSettingsDialog.jsx'
import PipelineDetail from './PipelineDetail.jsx'

const UNASSIGNED = 'Unassigned'

function readRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '')
  const match = hash.match(/^jobs\/pipeline\/(.+)$/)
  return match ? { view: 'pipeline', name: decodeURIComponent(match[1]) } : { view: 'home' }
}

const go = (href) => {
  window.location.hash = href.startsWith('#') ? href : `#${href}`
}

function attributeValues(attribute, tasks) {
  const defined = attribute?.values ?? []
  const used = tasks.map((task) => task.attributes?.[attribute?.name]).filter(Boolean)
  return [...new Set([...defined, ...used])]
}

function groupJobs(jobs, groupBy, filterValue, attribute) {
  const visible = filterValue
    ? jobs.filter((job) => (job.attributes?.[groupBy] || UNASSIGNED) === filterValue)
    : jobs
  const buckets = new Map()
  for (const job of visible) {
    const value = job.attributes?.[groupBy] || UNASSIGNED
    if (!buckets.has(value)) buckets.set(value, [])
    buckets.get(value).push(job)
  }
  const order = [...(attribute?.values ?? []), UNASSIGNED]
  const ordered = order.filter((value) => buckets.has(value))
  for (const value of buckets.keys()) {
    if (!ordered.includes(value)) ordered.push(value)
  }
  return ordered.map((name) => ({ name, jobs: buckets.get(name) }))
}

export default function App() {
  const [jobs, setJobs] = useState([])
  const [paused, setPaused] = useState(false)
  const [missingConfig, setMissingConfig] = useState(false)
  const [queues, setQueues] = useState({})
  const [preparing, setPreparing] = useState({})
  const [uploading, setUploading] = useState({})
  const [browserAvailable, setBrowserAvailable] = useState(false)
  const [openBrowsers, setOpenBrowsers] = useState({})
  const [liveLogs, setLiveLogs] = useState({})
  const [modals, setModals] = useState([])
  const [settingsJob, setSettingsJob] = useState(null)
  const [attributes, setAttributes] = useState([])
  const [defaultGroupBy, setDefaultGroupBy] = useState('')
  const [groupBy, setGroupBy] = useState('')
  const [filterValue, setFilterValue] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem('fl0w-density') === 'compact' ? 'compact' : 'comfortable'
    } catch {
      return 'comfortable'
    }
  })
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('fl0w-collapsed-groups') || '[]'))
    } catch {
      return new Set()
    }
  })
  const [attributesOpen, setAttributesOpen] = useState(false)
  const [route, setRoute] = useState(() => readRoute())

  const uploadAborts = useRef(new Map())

  const toast = (message, tone = 'success') => showToast(message, tone)

  /* ---------- modal helpers (promise-based) ---------- */

  const openModal = (kind, props, resolve) => {
    const id = crypto.randomUUID()
    setModals((current) => [...current, { id, kind, props, resolve }])
    return id
  }

  const closeModal = (id) => setModals((current) => current.filter((modal) => modal.id !== id))

  const confirmModal = (title, submitLabel = 'Run', lines = null) =>
    new Promise((resolve) => openModal('confirm', { title, submitLabel, lines, resolve }, resolve))

  const fieldsModal = (title, fields, submitLabel = 'Run') =>
    new Promise((resolve) => openModal('fields', { title, fields, submitLabel, resolve }, resolve))

  const pickerModal = (title, options) =>
    new Promise((resolve) => openModal('picker', { title, options, resolve }, resolve))

  const resultModal = (title, text, { live = false, paste = false, task = null, onDone = null } = {}) =>
    openModal('result', { title, text, live, paste, task, onDone }, null)

  /* ---------- task data ---------- */

  const loadJobs = useCallback(async () => {
    try {
      const data = await getJson('/api/jobs')
      const nextAttributes = data.attributes || []
      setJobs(data.jobs || [])
      setPaused(Boolean(data.paused))
      setAttributes(nextAttributes)
      setDefaultGroupBy(data.default_group_by || '')
      setGroupBy((current) => (
        nextAttributes.some((attribute) => attribute.name === current)
          ? current
          : data.default_group_by || nextAttributes[0]?.name || 'Category'
      ))
      setMissingConfig(Boolean(data.missing_config))
      setBrowserAvailable(Boolean(data.browser))
    } catch {
      // keep the last state
    }
  }, [])

  const tasks = jobs.filter((job) => job.type === 'task')
  const taskByName = (name) => tasks.find((task) => task.name === name)


  /* ---------- upload queue ---------- */

  const queueFiles = (task, files) => {
    if (!task) return
    // The caller clears the input value right after this call; that empties
    // the live FileList. Snapshot it before scheduling the state update.
    const incoming = Array.from(files)
    setQueues((current) => {
      const list = [...(current[task.name] ?? [])]
      for (const file of incoming) {
        const index = list.findIndex((queued) => queued.name === file.name)
        if (index !== -1) list.splice(index, 1)
        list.push(file)
      }
      return { ...current, [task.name]: list }
    })
  }

  const removeQueued = (task, file) => {
    setQueues((current) => ({
      ...current,
      [task.name]: (current[task.name] ?? []).filter((queued) => queued !== file),
    }))
  }

  const uploadFile = (task, file, onProgress) => {
    const request = uploadFileRequest(
      `/tasks/api/upload/${encodeURIComponent(task.name)}?name=${encodeURIComponent(file.name)}`,
      file,
      { onProgress },
    )
    uploadAborts.current.set(task.name, request)
    return request
  }

  /* ---------- running ---------- */

  const runTask = async (task, options = {}) => {
    const extra = {}
    const prompts = task.prompts || []
    const confirmPrompt = prompts.find((prompt) => prompt.type === 'confirm')
    const secretPrompts = prompts.filter((prompt) => prompt.type !== 'confirm')
    if (confirmPrompt) {
      const ok = await confirmModal(confirmPrompt.label || `Run ${task.name}?`)
      if (!ok) return
      extra[confirmPrompt.key] = true
    }
    if (secretPrompts.length) {
      const values = await fieldsModal(task.name, secretPrompts.map((prompt) => ({ label: prompt.label, type: prompt.type })))
      if (!values) return
      secretPrompts.forEach((prompt, index) => {
        if (values[index]) extra[prompt.key] = values[index]
      })
    }
    if (!prompts.length && !task.uploads && !options.skipGenericConfirm) {
      const ok = await confirmModal(`Run ${task.name}?`)
      if (!ok) return
    }
    // Global-drop detection queues files and runs in the same tick; pass the
    // detected batch explicitly so the run does not read a stale queue state.
    const files = options.files ?? queues[task.name] ?? []
    if (task.uploads && !files.length) {
      toast('Drop files here first', 'error')
      return
    }
    if (task.uploads) {
      setUploading((current) => ({ ...current, [task.name]: 0 }))
      const prunePaths = task.client_prune ?? []
      try {
        let done = 0
        for (const original of files) {
          let file = original
          try {
            if (prunePaths.length && /\.tar\.gz$/i.test(file.name)) {
              const controller = new AbortController()
              uploadAborts.current.set(task.name, { abort: () => controller.abort() })
              setPreparing((current) => ({ ...current, [task.name]: (done / files.length) * 100 }))
              try {
                file = await pruneTarGz(file, {
                  drop: prunePaths,
                  signal: controller.signal,
                  onProgress: (fraction) => {
                    setPreparing((current) => ({
                      ...current,
                      [task.name]: ((done + fraction) / files.length) * 100,
                    }))
                  },
                })
              } finally {
                setPreparing((current) => {
                  const next = { ...current }
                  delete next[task.name]
                  return next
                })
                uploadAborts.current.delete(task.name)
              }
            }
            await uploadFile(task, file, (fraction) => {
              setUploading((current) => ({ ...current, [task.name]: ((done + fraction) / files.length) * 100 }))
            })
          } catch (err) {
            if (err.message !== 'Upload cancelled') toast(err.message, 'error')
            return
          }
          done += 1
          setUploading((current) => ({ ...current, [task.name]: (done / files.length) * 100 }))
        }
      } finally {
        setPreparing((current) => {
          const next = { ...current }
          delete next[task.name]
          return next
        })
        setUploading((current) => {
          const next = { ...current }
          delete next[task.name]
          return next
        })
        uploadAborts.current.delete(task.name)
      }
    }
    try {
      const result = await postJson(`/api/jobs/${encodeURIComponent(task.id)}/run`, extra)
      if (task.uploads) {
        setQueues((current) => {
          const next = { ...current }
          delete next[task.name]
          return next
        })
      }
      setLiveLogs((current) => ({ ...current, [task.name]: [] }))
      if (task.browser && browserAvailable) {
        setOpenBrowsers((current) => ({ ...current, [task.name]: true }))
      }
      if (result?.queued) toast(`${task.name} queued — another task sharing its destination is running`, 'error')
      await loadJobs()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const runAction = async (task, action) => {
    const prompts = action.prompts || []
    const extra = {}
    const confirmPrompt = prompts.find((prompt) => prompt.type === 'confirm')
    const inputPrompts = prompts.filter((prompt) => prompt.type !== 'confirm')
    if (confirmPrompt) {
      const ok = await confirmModal(confirmPrompt.label || `${action.label}?`)
      if (!ok) return
      extra[confirmPrompt.key] = true
    }
    if (inputPrompts.length) {
      const values = await fieldsModal(
        `${task.name} — ${action.label}`,
        inputPrompts.map((prompt) => ({ label: prompt.label, type: prompt.type })),
      )
      if (!values) return
      inputPrompts.forEach((prompt, index) => {
        if (values[index]) extra[prompt.key] = values[index]
      })
      const missing = inputPrompts
        .filter((prompt) => (action.require || []).includes(prompt.key) && !extra[prompt.key])
        .map((prompt) => prompt.label)
      if (missing.length) {
        toast(`Missing required input: ${missing.join(', ')}`, 'error')
        return
      }
    }
    try {
      await postJson(`/tasks/api/actions/${encodeURIComponent(task.name)}/${encodeURIComponent(action.key)}`, extra)
      setLiveLogs((current) => ({ ...current, [task.name]: [] }))
      toast(`${task.name} — ${action.label} started`)
      await loadJobs()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const cancelRun = async (taskName) => {
    if (uploading[taskName] != null || preparing[taskName] != null || uploadAborts.current.has(taskName)) {
      setUploading((current) => {
        const next = { ...current }
        delete next[taskName]
        return next
      })
      setPreparing((current) => {
        const next = { ...current }
        delete next[taskName]
        return next
      })
      uploadAborts.current.get(taskName)?.abort()
      uploadAborts.current.delete(taskName)
      toast('Upload cancelled', 'error')
      return
    }
    try {
      const task = taskByName(taskName)
      const result = await postJson(`/api/jobs/${encodeURIComponent(task?.id ?? taskName)}/cancel`, {})
      if (result?.queued) toast('Removed from queue', 'error')
      else toast('Stopping the task…', 'error')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  /* ---------- global dropzone ---------- */

  const handleGlobalFiles = async (fileList) => {
    const byTask = new Map()
    for (const file of Array.from(fileList)) {
      try {
        const { result } = await postJson(`/tasks/api/detect?name=${encodeURIComponent(file.name)}`, {})
        if (!result) {
          toast(`No task matches ${file.name} — drop it onto the matching card instead`, 'error')
          continue
        }
        let taskName = result.task
        if (result.ambiguous.length > 1) {
          const options = result.ambiguous.map((name) => taskByName(name)).filter(Boolean)
          const picked = await pickerModal(`Which task is ${file.name} for?`, options)
          if (!picked) continue
          taskName = picked.name
        }
        const task = taskByName(taskName)
        if (!task) continue
        if (!byTask.has(task.name)) byTask.set(task.name, { task, files: [] })
        byTask.get(task.name).files.push(file)
      } catch (err) {
        toast(err.message, 'error')
      }
    }
    const entries = [...byTask.values()]
    if (!entries.length) return
    for (const { task, files } of entries) queueFiles(task, files)
    const ok = await confirmModal(
      'Detected — run all now?',
      'Run',
      entries.map(({ task, files }) => `${task.name} (${files.length} file${files.length > 1 ? 's' : ''})`),
    )
    if (!ok) return
    for (const { task, files } of entries) {
      runTask(task, { skipGenericConfirm: true, files })
    }
  }

  /* ---------- polling + logs ---------- */

  const finishPaste = async (task, close) => {
    try {
      const result = await postJson(`/tasks/api/paste_done/${encodeURIComponent(task)}`, {})
      close()
      if (!result.committed) {
        toast('No commit_dir configured for this task — nothing to commit', 'error')
        return
      }
      toast(`Committed ${result.dest || ''}`)
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const poll = useCallback(async () => {
    let activity = false
    try {
      const status = await getJson('/tasks/api/status')
      const logsToAppend = status.runs ?? []
      if (logsToAppend.length) {
        activity = true
        setLiveLogs((current) => {
          const next = { ...current }
          for (const run of logsToAppend) {
            next[run.task] = [...(next[run.task] ?? []), ...(run.log ?? [])].slice(-1000)
          }
          return next
        })
      }
      for (const done of status.done ?? []) {
        activity = true
        const label = done.action_label ? `${done.task} · ${done.action_label}` : done.task
        toast(`${label}: ${done.ok ? 'OK' : 'FAILED'} — ${done.summary.slice(0, 200)}`, done.ok ? 'success' : 'error')
        if (done.ok && done.paste) {
          getJson(`/tasks/api/log/${encodeURIComponent(done.task)}`)
            .then(({ output }) => resultModal(`${done.task} — output to paste`, output ?? '', {
              paste: true,
              task: done.task,
              onDone: (close) => finishPaste(done.task, close),
            }))
            .catch(() => {})
        }
      }
      if (activity) await loadJobs()
    } catch {
      // transient poll failure
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadJobs])

  const openLog = async (task) => {
    if (task.running) {
      resultModal(`${task.name} — live log`, (liveLogs[task.name] ?? []).join('\n'), { live: true, task: task.name })
      return
    }
    try {
      const { output } = await getJson(`/api/jobs/${encodeURIComponent(task.id)}/log`)
      resultModal(`${task.name} — log`, output || '(no log recorded yet)')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const saveSettings = async (task, settings) => {
    const saved = await putJson(`/api/jobs/${encodeURIComponent(task.id)}/settings`, settings)
    setSettingsJob(null)
    toast('Job settings saved.')
    await loadJobs()
    return saved
  }

  const saveAttributes = async (settings) => {
    const saved = await putJson('/api/attributes', settings)
    setAttributes(saved.attributes ?? attributes)
    setDefaultGroupBy(saved.default_group_by ?? defaultGroupBy)
    setAttributesOpen(false)
    toast('Attributes saved.')
    await loadJobs()
    return saved
  }

  const runPipeline = async (job) => {
    try {
      const result = await postJson(`/api/jobs/${encodeURIComponent(job.id)}/run`, {})
      toast(result?.processed ? `${job.name}: queued ${result.processed} file(s)` : `${job.name}: no files to process`)
      await loadJobs()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const runJob = (job) => (job.type === 'pipeline' ? runPipeline(job) : runTask(job))

  const togglePaused = async () => {
    try {
      await postJson('/pipelines/api/pause', { paused: !paused })
      toast(paused ? 'Pipeline processing resumed' : 'Pipeline processing paused')
      await loadJobs()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  useEffect(() => {
    const total = Object.values(liveLogs).reduce((sum, lines) => sum + lines.length, 0)
    const pre = document.querySelector('dialog[open] .log-box')
    if (pre && total) pre.scrollTop = pre.scrollHeight
  }, [liveLogs])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Poll run status while the page is open (the poll callback is refreshed
  // internally, so this timer never restarts).
  usePolling(poll, 700, { runImmediately: false })

  const groupingAttribute = attributes.find((attribute) => attribute.name === groupBy)
  const scopedJobs = typeFilter === 'all' ? jobs : jobs.filter((job) => job.type === typeFilter)
  const filterValues = attributeValues(groupingAttribute, scopedJobs)
  const activeFilter = filterValues.includes(filterValue) ? filterValue : ''
  const visibleGroups = groupJobs(scopedJobs, groupBy, activeFilter, groupingAttribute)
  const changeDensity = (value) => {
    setDensity(value)
    try {
      localStorage.setItem('fl0w-density', value)
    } catch {
      // storage unavailable
    }
  }
  const allCollapsed = visibleGroups.length > 0 && visibleGroups.every((group) => collapsedGroups.has(group.name))
  const toggleAllGroups = () => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      for (const group of visibleGroups) {
        if (allCollapsed) next.delete(group.name)
        else next.add(group.name)
      }
      try {
        localStorage.setItem('fl0w-collapsed-groups', JSON.stringify([...next]))
      } catch {
        // storage unavailable
      }
      return next
    })
  }
  const toggleGroup = (name) => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      try {
        localStorage.setItem('fl0w-collapsed-groups', JSON.stringify([...next]))
      } catch {
        // storage unavailable
      }
      return next
    })
  }
  const openPipeline = (job) => go(`/jobs/pipeline/${encodeURIComponent(job.name)}`)

  if (route.view === 'pipeline') {
    const job = jobs.find((entry) => entry.type === 'pipeline' && entry.name === route.name)
    return (
      <>
        {job ? (
          <PipelineDetail
            job={job}
            attributes={attributes}
            onChanged={loadJobs}
            onBack={() => go('/')}
          />
        ) : (
          <>
            <AppHeader brand={getBrand('fl0w')} name={route.name} back={{ href: '#/', label: 'All jobs' }} />
            <Page width="wide"><EmptyState title="Pipeline not found" description="It may have been renamed or removed." /></Page>
          </>
        )}
        <Toasts />
      </>
    )
  }

  /* ---------- render ---------- */

  return (
    <>
      <AppHeader
        brand={getBrand('fl0w')}
        meta="Scheduled tasks and file pipelines"
        actions={(
          <>
            {missingConfig ? (
              <span className="alert-badge">Missing config.mjs — create it (see README.md for the schema)</span>
            ) : null}
            <Button
              variant="outline"
              icon={paused ? Play : Pause}
              title={paused ? 'Resume pipeline processing' : 'Pause pipeline processing'}
              aria-label="Pause or resume pipeline processing"
              onClick={togglePaused}
            />
            <Button variant="outline" icon={RefreshCw} title="Refresh" aria-label="Refresh jobs" onClick={() => loadJobs()} />
            <ThemeToggle />
          </>
        )}
      />

      <Page width="wide">
        <section className="card global-drop">
          <Dropzone
            className="global-drop__dropzone"
            onFiles={handleGlobalFiles}
            label="Drop an export file here, or choose files"
            hint="Detected automatically — you confirm before it runs"
          />
        </section>

        <section className="card task-toolbar">
          <div className="task-toolbar__row">
            <Field label="Type" htmlFor="job-type-filter" className="task-toolbar__field">
              <select
                id="job-type-filter"
                data-testid="type-filter"
                value={typeFilter}
                onChange={(event) => {
                  setTypeFilter(event.target.value)
                  setFilterValue('')
                }}
              >
                <option value="all">All jobs</option>
                <option value="task">Tasks</option>
                <option value="pipeline">Pipelines</option>
              </select>
            </Field>
            <Field label="Layout" htmlFor="job-density" className="task-toolbar__field">
              <select
                id="job-density"
                data-testid="density"
                value={density}
                onChange={(event) => changeDensity(event.target.value)}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </Field>
            <Field label="Group by" htmlFor="task-group-by" className="task-toolbar__field">
              <select
                id="task-group-by"
                data-testid="group-by"
                value={groupBy}
                onChange={(event) => {
                  setGroupBy(event.target.value)
                  setFilterValue('')
                }}
              >
                {attributes.map((attribute) => (
                  <option key={attribute.name} value={attribute.name}>{attribute.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Show" htmlFor="task-filter-value" className="task-toolbar__field">
              <select
                id="task-filter-value"
                data-testid="filter-value"
                value={activeFilter}
                onChange={(event) => setFilterValue(event.target.value)}
              >
                <option value="">All {groupBy || 'tasks'}</option>
                {filterValues.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </Field>
            <Button
              variant="outline"
              icon={allCollapsed ? ChevronDown : ChevronUp}
              data-testid="toggle-all-groups"
              onClick={toggleAllGroups}
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </Button>
            <Button
              variant="outline"
              icon={SlidersHorizontal}
              className="task-toolbar__manage"
              data-testid="manage-attributes"
              onClick={() => setAttributesOpen(true)}
            >
              Attributes
            </Button>
          </div>
          <p className="hint">
            Grouped by {groupBy || 'job'}. Schedules, categories and notifications for every job live in
            jobs-meta.json.
            {defaultGroupBy && defaultGroupBy !== groupBy ? ` Default grouping: ${defaultGroupBy}.` : ''}
          </p>
        </section>

        {visibleGroups.map((group) => {
          const collapsed = collapsedGroups.has(group.name)
          return (
          <div key={group.name} data-testid={`group-${group.name}`}>
            <button
              type="button"
              className="category-header"
              aria-expanded={!collapsed}
              data-testid={`group-toggle-${group.name}`}
              onClick={() => toggleGroup(group.name)}
            >
              <span className="category-title">
                <ChevronDown className="category-header__chevron" size={18} strokeWidth={2} aria-hidden="true" />
                {group.name}
              </span>
              <span className="category-count">{group.jobs.length} job{group.jobs.length === 1 ? '' : 's'}</span>
            </button>
            {!collapsed ? <div className="task-grid">
              {group.jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  attributes={attributes}
                  groupBy={groupBy}
                  preparing={preparing}
                  uploading={uploading}
                  queues={queues}
                  browserAvailable={browserAvailable}
                  openBrowsers={openBrowsers}
                  onToggleBrowser={(name) => setOpenBrowsers((current) => ({ ...current, [name]: !current[name] }))}
                  onQueueFiles={queueFiles}
                  onRemoveQueued={removeQueued}
                  onSettings={setSettingsJob}
                  onAction={runAction}
                  onRun={runJob}
                  onCancel={(jobEntry) => cancelRun(jobEntry.name)}
                  onLog={openLog}
                  onFiles={openPipeline}
                  compact={density === 'compact'}
                />
              ))}
            </div> : null}
          </div>
          )
        })}

        {!visibleGroups.length ? (
          <EmptyState title="No jobs match this filter" description="Change the group or filter, or add a job to the config." />
        ) : null}

        <p className="footer-note">Run state is stored in the gitignored .state folder of the config repo; dropped files are held in the browser until you click Run.</p>
      </Page>

      {settingsJob ? (
        <JobSettingsDialog
          job={settingsJob}
          attributes={attributes}
          onClose={() => setSettingsJob(null)}
          onSave={(settings) => saveSettings(settingsJob, settings)}
        />
      ) : null}

      {attributesOpen ? (
        <AttributesModal
          attributes={attributes}
          defaultGroupBy={defaultGroupBy || groupBy}
          onClose={() => setAttributesOpen(false)}
          onSave={saveAttributes}
        />
      ) : null}

      {modals.map((entry) => {
        const close = () => closeModal(entry.id)
        if (entry.kind === 'confirm') return <ConfirmModal key={entry.id} props={entry.props} close={close} />
        if (entry.kind === 'fields') return <FieldsModal key={entry.id} props={entry.props} close={close} />
        if (entry.kind === 'picker') return <PickerModal key={entry.id} props={entry.props} close={close} />
        return <ResultModal key={entry.id} props={entry.props} close={close} liveLogs={liveLogs} />
      })}

      <Toasts />
    </>
  )
}
