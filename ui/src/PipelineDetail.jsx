import { useCallback, useEffect, useMemo, useState } from 'react'
import { Play, RefreshCw, Settings, Wrench } from 'lucide-react'
import {
  AppHeader,
  Button,
  getBrand,
  getJson,
  Page,
  postJson,
  putJson,
  showToast,
  StatTiles,
  ThemeToggle,
} from '@dscpln/ui-kit'
import FolderCard from '../../src/pipelines/ui/src/components/FolderCard.jsx'
import ActivityCard from '../../src/pipelines/ui/src/components/ActivityCard.jsx'
import TrashCard from '../../src/pipelines/ui/src/components/TrashCard.jsx'
import CleanupDialog from '../../src/pipelines/ui/src/components/dialogs/CleanupDialog.jsx'
import ConfirmDialog from '../../src/pipelines/ui/src/components/dialogs/ConfirmDialog.jsx'
import ReportDialog from '../../src/pipelines/ui/src/components/dialogs/ReportDialog.jsx'
import RestoreDialog from '../../src/pipelines/ui/src/components/dialogs/RestoreDialog.jsx'
import ReviewDialog from '../../src/pipelines/ui/src/components/dialogs/ReviewDialog.jsx'
import SetDateDialog from '../../src/pipelines/ui/src/components/dialogs/SetDateDialog.jsx'
import SettingsDialog from '../../src/pipelines/ui/src/components/dialogs/SettingsDialog.jsx'
import TaskSettingsModal from '../../src/tasks/ui/src/components/TaskSettingsModal.jsx'
import { folderStats } from '../../src/pipelines/ui/src/lib/view.js'

const emptyTrash = { entries: [], selectAll: false }

export default function PipelineDetail({ job, attributes, onChanged }) {
  const [currentJob, setCurrentJob] = useState(job)
  const [state, setState] = useState(null)
  const [trash, setTrash] = useState(emptyTrash)
  const [trashSelection, setTrashSelection] = useState(new Set())
  const [logLines, setLogLines] = useState([])
  const [expanded, setExpanded] = useState(new Set([job.name]))
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [reportDialog, setReportDialog] = useState(null)
  const [cleanupDialog, setCleanupDialog] = useState(null)
  const [setDateDialog, setSetDateDialog] = useState(null)
  const [restoreDialog, setRestoreDialog] = useState(null)
  const [reviewDialog, setReviewDialog] = useState(null)
  const [reviewBusy, setReviewBusy] = useState('')
  const [reviewBulkBusy, setReviewBulkBusy] = useState('')
  const [settingsDraft, setSettingsDraft] = useState(null)
  const [jobSettingsOpen, setJobSettingsOpen] = useState(false)

  useEffect(() => { setCurrentJob(job) }, [job])

  const notify = (message, tone = 'success') => showToast(message, tone)

  const refresh = useCallback(async () => {
    try { setState(await getJson('/pipelines/api/state')) } catch { /* keep last */ }
  }, [])
  const refreshTrash = useCallback(async () => {
    try {
      const { entries } = await getJson('/pipelines/api/trash')
      setTrash({ entries, selectAll: false })
      setTrashSelection(new Set())
    } catch { /* keep last */ }
  }, [])
  const refreshLog = useCallback(async () => {
    try { setLogLines((await getJson('/pipelines/api/log?limit=200')).lines ?? []) } catch { /* keep last */ }
  }, [])

  useEffect(() => {
    refresh(); refreshTrash(); refreshLog()
    const timer = setInterval(() => { refresh(); refreshLog() }, 5000)
    return () => clearInterval(timer)
  }, [refresh, refreshTrash, refreshLog])

  const folder = state?.folders?.find((entry) => entry.name === currentJob.name) ?? null
  const stats = folder ? folderStats(folder) : null

  const act = async (path, body = {}) => {
    try {
      const result = await postJson(path, body)
      await Promise.all([refresh(), refreshLog()])
      return result
    } catch (err) {
      notify(err.message, 'error')
      return null
    }
  }

  const processNow = async () => {
    try {
      const result = await postJson(`/api/jobs/${encodeURIComponent(currentJob.id)}/run`, {})
      notify(result?.processed ? `Queued ${result.processed} file(s)` : 'No files to process')
      await refresh()
      onChanged?.()
    } catch (err) { notify(err.message, 'error') }
  }

  const fileAction = (file, action, extra = {}) => act(
    `/pipelines/api/actions/${encodeURIComponent(currentJob.name)}/${encodeURIComponent(file)}`,
    { action, ...extra },
  )

  const askConfirm = (title, text, confirmLabel, tone = 'danger') => new Promise((resolve) => {
    setConfirmDialog({ title, text, confirmLabel, tone, resolve: (value) => { setConfirmDialog(null); resolve(value) } })
  })

  const openCleanup = async () => {
    try {
      const preview = await getJson(`/pipelines/api/cleanup/${encodeURIComponent(currentJob.name)}`)
      if (!preview.files.length) return notify('Nothing to clean up in this folder.', 'error')
      setCleanupDialog({
        folder: currentJob.name,
        files: preview.files,
        totalBytes: preview.totalBytes,
        selected: new Set(preview.files.map((file) => file.name)),
      })
    } catch (err) { notify(err.message, 'error') }
  }

  const runCleanup = async () => {
    const names = [...cleanupDialog.selected]
    if (!names.length) return notify('No files selected.', 'error')
    setCleanupDialog(null)
    try {
      const { results } = await postJson(`/pipelines/api/cleanup/${encodeURIComponent(cleanupDialog.folder)}`, { names })
      const failed = results.filter((result) => !result.ok)
      notify(`Moved ${results.length - failed.length} file(s) to trash.`, failed.length ? 'error' : 'success')
      if (failed.length) setReportDialog({ entries: failed })
    } catch (err) { notify(`Cleanup failed: ${err.message}`, 'error') }
    refresh(); refreshTrash(); onChanged?.()
  }

  const openReview = async () => {
    try {
      const all = await getJson('/pipelines/api/review')
      const entries = (all.entries ?? []).filter((entry) => entry.folder === currentJob.name)
      const reviewedAudio = (all.reviewedAudio ?? []).filter((entry) => entry.folder === currentJob.name)
      setReviewDialog({ entries, reviewedAudio })
    } catch (err) { notify(err.message, 'error') }
  }

  const reviewRequest = (group, action) => postJson(
    `/pipelines/api/review/reviewed-audio/${action}`,
    group.file
      ? { folder: group.folder, file: group.file }
      : { folder: group.folder, chat: group.chat, date: group.date },
  )

  const groupKey = (group) => group.file
    ? `${group.folder}\u0000file\u0000${group.file}`
    : `${group.folder}\u0000${group.chat}\u0000${group.date}`

  const approveReviewedAudio = async (group) => {
    setReviewBusy(groupKey(group))
    try {
      const result = await reviewRequest(group, 'approve')
      notify(result?.alreadyPlaced ? 'Already merged; source clips moved to trash.' : 'Moved to the destination.')
      await openReview(); refresh(); refreshTrash(); onChanged?.()
    } catch (err) { notify(`Approve failed: ${err.message}`, 'error') }
    finally { setReviewBusy('') }
  }

  const deleteReviewedAudio = async (group) => {
    const label = group.file || `${group.chat || '(root)'} / ${group.date}`
    if (!(await askConfirm('Confirm', group.file ? `Move ${label} to trash?` : `Move ${group.count} audio clip(s) for ${label} to trash?`, 'Delete'))) return
    setReviewBusy(groupKey(group))
    try {
      await reviewRequest(group, 'delete')
      notify(group.file ? 'File moved to trash.' : 'Audio clips moved to trash.')
      await openReview(); refresh(); refreshTrash(); onChanged?.()
    } catch (err) { notify(`Delete failed: ${err.message}`, 'error') }
    finally { setReviewBusy('') }
  }

  const approveAllReviewedAudio = async (groups) => {
    if (!groups.length) return
    if (groups.some((group) => group.settling)) return notify('Wait for all items to settle before approving them.', 'error')
    const allFiles = groups.every((group) => group.file)
    const message = allFiles
      ? `Standardize and move all ${groups.length} files to the destination?`
      : `Merge and move all ${groups.length} reviewed audio groups to the destination?`
    if (!(await askConfirm('Confirm', message, 'Approve all', 'primary'))) return
    setReviewBulkBusy('approve')
    const failures = []
    let done = 0
    try {
      for (const group of groups) {
        try { await reviewRequest(group, 'approve'); done += 1 } catch (err) { failures.push(`${group.file || group.date}: ${err.message}`) }
      }
      await openReview(); refresh(); refreshTrash(); onChanged?.()
      if (failures.length) notify(`${done} of ${groups.length} approved. ${failures.length} failed: ${failures[0]}`, 'error')
      else notify(`${done} reviewed audio item(s) moved to the destination.`)
    } finally { setReviewBulkBusy('') }
  }

  const deleteAllReviewedAudio = async (groups) => {
    if (!groups.length) return
    if (groups.some((group) => group.settling)) return notify('Wait for all items to settle before deleting them.', 'error')
    const fileCount = groups.reduce((sum, group) => sum + (group.files?.length ?? 1), 0)
    if (!(await askConfirm('Confirm', `Move ${fileCount} source file(s) from ${groups.length} reviewed audio item(s) to trash?`, 'Delete all'))) return
    setReviewBulkBusy('delete')
    const failures = []
    let done = 0
    try {
      for (const group of groups) {
        try { await reviewRequest(group, 'delete'); done += 1 } catch (err) { failures.push(`${group.file || group.date}: ${err.message}`) }
      }
      await openReview(); refresh(); refreshTrash(); onChanged?.()
      if (failures.length) notify(`${done} of ${groups.length} deleted. ${failures.length} failed: ${failures[0]}`, 'error')
      else notify(`${fileCount} source file(s) moved to trash.`)
    } finally { setReviewBulkBusy('') }
  }

  const reviewAction = async (name, id, place) => {
    if (!place && !(await askConfirm('Confirm', 'Discard this parked item?', 'Discard'))) return
    await postJson(place ? '/pipelines/api/review/place' : '/pipelines/api/review/discard', { folder: name, id })
    await openReview(); refresh(); onChanged?.()
  }

  const reviewActionAll = async (name, place) => {
    if (!place && !(await askConfirm('Confirm', `Discard every parked item in ${name}?`, 'Discard all'))) return
    await postJson(place ? '/pipelines/api/review/place-all' : '/pipelines/api/review/discard-all', { folder: name })
    await openReview(); refresh(); onChanged?.()
  }

  const filteredTrash = useMemo(() => {
    const entries = (trash.entries ?? [])
      .map((entry) => {
        const files = entry.files.filter((file) => !file.folder || file.folder === currentJob.name)
        return { ...entry, files, count: files.length, bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0) }
      })
      .filter((entry) => entry.count > 0)
    return { entries, selectAll: false }
  }, [trash.entries, currentJob.name])

  const toggleTrashSelection = (key, checked) => setTrashSelection((current) => {
    const next = new Set(current)
    if (checked) next.add(key); else next.delete(key)
    return next
  })

  const selectAllTrash = (checked) => {
    const keys = filteredTrash.entries.flatMap((entry) => entry.files.slice(0, 300).map((file) => `${entry.day}/${file.name}`))
    setTrashSelection(checked ? new Set(keys) : new Set())
    setTrash({ ...filteredTrash, selectAll: checked })
  }

  const restoreSelected = () => {
    const items = [...trashSelection].map((key) => {
      const [day, ...rest] = key.split('/')
      return { day, name: rest.join('/') }
    })
    if (!items.length) return notify('No files selected.', 'error')
    setRestoreDialog({ items, dir: '', error: '' })
  }

  const restoreFiles = async (items, targetDir) => {
    try {
      const { results } = await postJson('/pipelines/api/trash/restore', { files: items, targetDir: targetDir || null })
      const failed = results.filter((result) => !result.ok)
      notify(`Restored ${results.length - failed.length} file(s).`, failed.length ? 'error' : 'success')
      if (failed.length) setReportDialog({ entries: failed.map((file) => ({ name: file.name, reason: file.reason })) })
    } catch (err) { notify(err.message, 'error') }
    refreshTrash(); refresh(); onChanged?.()
  }

  const removeTrash = async () => {
    if (!(await askConfirm('Confirm', 'Permanently delete every trashed file?', 'Empty trash'))) return
    await postJson('/pipelines/api/trash/empty', {})
    refreshTrash(); refreshLog(); onChanged?.()
  }

  const openSettings = () => setSettingsDraft(structuredClone(state.config))
  const updateDraft = (mutator) => setSettingsDraft((current) => {
    const next = structuredClone(current)
    mutator(next)
    return next
  })
  const addFolder = () => updateDraft((draft) => {
    draft.folders = [...draft.folders, {
      name: '', source: '', destination: '', method: 'standardize', settleSeconds: 60,
      groupWindowSeconds: 15, placement: 'auto', onChanged: 'overwrite', notify: 'all',
    }]
  })
  const saveSettings = async () => {
    const config = structuredClone(settingsDraft)
    config.concurrency = Number(config.concurrency)
    config.trashRetentionDays = Number(config.trashRetentionDays)
    config.settleSeconds = Number(config.settleSeconds)
    for (const entry of config.folders) {
      entry.settleSeconds = Number(entry.settleSeconds)
      entry.groupWindowSeconds = Number(entry.groupWindowSeconds)
      entry.filePattern ||= null
      if (entry.method === 'reviewed-audio') entry.recursive = true
      if (entry.method === 'copy') entry.placement = 'auto'
    }
    try {
      await putJson('/pipelines/api/config', config)
      setSettingsDraft(null)
      notify('Pipeline settings saved.')
      refresh(); onChanged?.()
    } catch (err) { notify(`Save failed: ${err.message}`, 'error') }
  }

  const saveJobSettings = async (patch) => {
    const saved = await putJson(`/api/jobs/${encodeURIComponent(currentJob.id)}/settings`, patch)
    setCurrentJob(saved)
    setJobSettingsOpen(false)
    notify('Job settings saved.')
    onChanged?.()
  }

  const statusTone = state?.paused ? 'paused' : state?.dryRun ? 'dry' : 'live'
  const statusText = state?.paused ? 'paused' : state?.dryRun ? 'dry run' : 'live'

  if (!folder) {
    return (
      <>
        <AppHeader brand={getBrand('fl0w')} name={currentJob.name} back={{ href: '#/', label: 'All jobs' }} />
        <Page width="wide"><p className="muted">Loading pipeline…</p></Page>
      </>
    )
  }

  return (
    <>
      <AppHeader
        brand={getBrand('fl0w')}
        name={currentJob.name}
        subtitle={`Pipeline · ${currentJob.method}`}
        back={{ href: '#/', label: 'All jobs' }}
        meta={<span className={`status-tag status-tag--${statusTone}`}><span>{statusText}</span></span>}
        actions={(
          <>
            <Button variant="outline" icon={Play} onClick={processNow} disabled={currentJob.enabled === false}>
              Process now
            </Button>
            <Button variant="ghost" icon={Wrench} onClick={() => setJobSettingsOpen(true)}>Job settings</Button>
            <Button variant="ghost" icon={Settings} onClick={openSettings} aria-label="Pipeline settings" />
            <Button variant="ghost" icon={RefreshCw} onClick={() => { refresh(); refreshTrash(); refreshLog() }} aria-label="Refresh pipeline" />
            <ThemeToggle />
          </>
        )}
      />

      <Page width="wide">
        <section className="card card--hero">
          <div className="card__header">
            <h2 className="card__title">Overview</h2>
            <span className="card__context">{currentJob.source} → {currentJob.destination}</span>
          </div>
          <StatTiles items={[
            { label: 'Pending', value: stats.pending, tone: stats.pending ? 'warn' : null },
            { label: 'Processing', value: stats.processing },
            { label: 'Processed', value: stats.processed },
            { label: 'Issues', value: stats.issues, tone: stats.issues ? 'over' : null },
          ]} />
          <div className="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={stats.percent}>
            <div className="progress__fill" style={{ width: `${stats.percent}%` }} />
          </div>
          <p className="pace">{folder.lastEventAt ? `Last change ${new Date(folder.lastEventAt).toLocaleString()} · ` : ''}{stats.processed} processed{stats.ignored ? ` · ${stats.ignored} ignored` : ''}</p>
        </section>

        <FolderCard
          folder={folder}
          expanded={expanded}
          onToggleExpanded={(open) => setExpanded((current) => {
            const next = new Set(current)
            if (open) next.add(folder.name); else next.delete(folder.name)
            return next
          })}
          onProcessNow={processNow}
          onOpenReview={openReview}
          onOpenCleanup={openCleanup}
          onFileAction={(file, action) => fileAction(file, action)}
          onSetDate={(file) => setSetDateDialog({ folder: folder.name, file, date: '', time: '00:00', error: '' })}
        />

        <div className="side-grid">
          <TrashCard
            trash={filteredTrash}
            trashSelection={trashSelection}
            retentionDays={state?.trashRetentionDays}
            onRefresh={refreshTrash}
            onSelectAll={selectAllTrash}
            onToggleSelection={toggleTrashSelection}
            onRestoreSelected={restoreSelected}
            onEmptyTrash={removeTrash}
          />
          <ActivityCard logLines={logLines} onRefresh={refreshLog} />
        </div>
      </Page>

      {jobSettingsOpen ? (
        <TaskSettingsModal
          task={currentJob}
          attributes={attributes}
          onClose={() => setJobSettingsOpen(false)}
          onSave={saveJobSettings}
        />
      ) : null}

      {cleanupDialog ? (
        <CleanupDialog
          dialog={cleanupDialog}
          onClose={() => setCleanupDialog(null)}
          onSelectAll={(checked) => setCleanupDialog((current) => ({ ...current, selected: checked ? new Set(current.files.map((file) => file.name)) : new Set() }))}
          onToggle={(name, checked) => setCleanupDialog((current) => {
            const next = new Set(current.selected)
            if (checked) next.add(name); else next.delete(name)
            return { ...current, selected: next }
          })}
          onMove={runCleanup}
        />
      ) : null}

      {setDateDialog ? (
        <SetDateDialog
          dialog={setDateDialog}
          onClose={() => setSetDateDialog(null)}
          setField={(patch) => setSetDateDialog((current) => ({ ...current, ...patch }))}
          onStandardize={async () => {
            if (!setDateDialog.date) return setSetDateDialog((current) => ({ ...current, error: 'Pick a date first.' }))
            const { file, date, time } = setDateDialog
            setSetDateDialog(null)
            await fileAction(file, 'setDate', { date: `${date} ${time || '00:00'}` })
            notify(`Standardizing ${file} with the chosen date.`)
          }}
        />
      ) : null}

      {restoreDialog ? (
        <RestoreDialog
          dialog={restoreDialog}
          onClose={() => setRestoreDialog(null)}
          onDirChange={(dir) => setRestoreDialog((current) => ({ ...current, dir }))}
          onRestore={async () => {
            if (!restoreDialog.dir.trim()) return setRestoreDialog((current) => ({ ...current, error: 'Enter a directory first.' }))
            const { items, dir } = restoreDialog
            setRestoreDialog(null)
            await restoreFiles(items, dir.trim())
          }}
        />
      ) : null}

      {reviewDialog ? (
        <ReviewDialog
          entries={reviewDialog.entries}
          reviewFolders={folder.placement === 'manual' || stats.review > 0 ? [folder] : []}
          reviewedAudio={reviewDialog.reviewedAudio ?? []}
          busy={reviewBusy}
          bulkBusy={reviewBulkBusy}
          onApproveReviewedAudio={approveReviewedAudio}
          onDeleteReviewedAudio={deleteReviewedAudio}
          onApproveAllReviewedAudio={approveAllReviewedAudio}
          onDeleteAllReviewedAudio={deleteAllReviewedAudio}
          onReviewAction={reviewAction}
          onReviewActionAll={reviewActionAll}
          onClose={() => setReviewDialog(null)}
        />
      ) : null}

      {settingsDraft ? (
        <SettingsDialog
          draft={settingsDraft}
          updateDraft={updateDraft}
          addFolder={addFolder}
          saveSettings={saveSettings}
          onClose={() => setSettingsDraft(null)}
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmDialog
          title={confirmDialog.title}
          text={confirmDialog.text}
          confirmLabel={confirmDialog.confirmLabel}
          tone={confirmDialog.tone}
          onResolve={(value) => confirmDialog.resolve(value)}
          onClose={() => confirmDialog.resolve(false)}
        />
      ) : null}

      {reportDialog ? <ReportDialog entries={reportDialog.entries} onClose={() => setReportDialog(null)} /> : null}
    </>
  )
}
