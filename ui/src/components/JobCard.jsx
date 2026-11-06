import { Download, FolderOpen, Play, ScrollText, Settings, Square } from 'lucide-react'
import { Button, StatusPill } from '@dscpln/ui-kit'
import JobTypeBadge from './JobTypeBadge.jsx'
import PipelineJobBody from './PipelineJobBody.jsx'
import TaskJobBody from './TaskJobBody.jsx'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const scheduleText = (schedule) => {
  const days = schedule?.days?.length ? schedule.days.map((day) => DAY_NAMES[day] ?? day).join(', ') : 'daily'
  return `${days} at ${schedule?.at ?? '—'}`
}

const elapsed = (started) => {
  if (!started) return ''
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - started))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? ` · ${hours}:${String(minutes).padStart(2, '0')}:${rest}` : ` · ${minutes}:${rest}`
}

export default function JobCard({
  job,
  attributes = [],
  groupBy,
  preparing = {},
  uploading = {},
  queues = {},
  browserAvailable = false,
  openBrowsers = {},
  onRun,
  onCancel,
  onSettings,
  onLog,
  onFiles,
  onAction,
  onToggleBrowser,
  onQueueFiles,
  onRemoveQueued,
}) {
  const files = queues[job.name] ?? []
  const isPreparing = preparing[job.name] != null
  const isUploading = uploading[job.name] != null
  const busy = job.running || job.queued || isPreparing || isUploading
  const canCancel = Boolean(job.capabilities?.cancel) && busy
  const pipelineErrors = Number(job.errors ?? 0)
  const pipelinePending = Number(job.pending ?? 0)
  const chips = attributes
    .filter((attribute) => attribute.name !== groupBy)
    .map((attribute) => ({ name: attribute.name, value: job.attributes?.[attribute.name] }))
    .filter((chip) => chip.value)

  let statusText = job.state?.last_run_text || 'Never run'
  let statusTone = job.pill || 'neutral'
  if (isPreparing) {
    statusText = `Pruning… ${Math.round(preparing[job.name])}%`
    statusTone = 'running'
  } else if (isUploading) {
    statusText = `Uploading… ${Math.round(uploading[job.name])}%`
    statusTone = 'running'
  } else if (job.running) {
    statusText = `Running${elapsed(job.started)}`
    statusTone = 'running'
  } else if (job.queued) {
    statusText = 'Queued…'
    statusTone = 'neutral'
  } else if (job.type === 'pipeline' && pipelineErrors) {
    statusText = `${pipelineErrors} issue${pipelineErrors === 1 ? '' : 's'}`
    statusTone = 'danger'
  } else if (job.type === 'pipeline' && pipelinePending) {
    statusText = `${pipelinePending} pending`
    statusTone = 'warn'
  }

  const runDisabled = job.enabled === false ||
    job.avail === false ||
    (job.type === 'task' && job.uploads && files.length === 0) ||
    (busy && !canCancel)

  const configActions = job.actions ?? []
  const hasActionState = configActions.some((action) => action.state)

  return (
    <section
      className={`card job-card job-card--${job.type}`}
      data-job-id={job.id}
      data-testid={`${job.type}-${job.name}`}
    >
      <div className="card__header job-card__header">
        <div className="job-card__heading">
          <h2 className="card-title">{job.name}</h2>
          <JobTypeBadge job={job} />
        </div>
        <StatusPill tone={statusTone}>{statusText}</StatusPill>
      </div>

      {chips.length ? (
        <div className="attribute-chips">
          {chips.map((chip) => (
            <span className="attribute-chip" key={chip.name} data-attribute={chip.name}>
              <span className="attribute-chip__name">{chip.name}</span>
              <span>{chip.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {job.schedule?.enabled ? (
        <div className="card-note">
          Scheduled {scheduleText(job.schedule)}
          {job.next_run ? ` · next ${new Date(job.next_run).toLocaleString()}` : ''}
          {job.schedule_missed ? ` · ${job.schedule_missed} missed` : ''}
        </div>
      ) : null}

      {job.avail === false ? <span className="alert-badge badge-unavail">{job.avail_reason || 'Unavailable'}</span> : null}

      <div className="job-card__body">
        {job.type === 'pipeline' ? (
          <PipelineJobBody job={job} />
        ) : (
          <TaskJobBody
            task={job}
            preparing={preparing}
            uploading={uploading}
            queues={queues}
            browserAvailable={browserAvailable}
            openBrowsers={openBrowsers}
            onToggleBrowser={onToggleBrowser}
            onQueueFiles={onQueueFiles}
            onRemoveQueued={onRemoveQueued}
          />
        )}
      </div>

      {job.export_url || configActions.length || hasActionState ? (
        <div className="job-card__extras">
          <div className="job-card__extra-actions">
            {job.export_url ? (
              <Button variant="outline" icon={Download} href={job.export_url} target="_blank" rel="noreferrer">
                Generate Export
              </Button>
            ) : null}
            {configActions.map((action) => (
              <Button
                key={action.key}
                variant="outline"
                disabled={busy}
                onClick={() => onAction(job, action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
          {hasActionState ? (
            <div className="action-status-list">
              {configActions.filter((action) => action.state).map((action) => (
                <div
                  key={action.key}
                  className={`action-status action-status--${action.state.ok ? 'ok' : 'fail'}`}
                  title={action.state.summary}
                >
                  <span className="action-status__label">{action.label}:</span>
                  <span className="action-status__summary">{action.state.summary || action.state.last_run_text}</span>
                  <span className="action-status__time">{action.state.last_run_text.split(' · ').at(-1)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="job-card__actions">
        {canCancel ? (
          <Button variant="danger" icon={Square} onClick={() => onCancel(job)}>Stop</Button>
        ) : (
          <Button variant="primary" icon={Play} onClick={() => onRun(job)} disabled={runDisabled}>
            Run
          </Button>
        )}
        <Button variant="outline" icon={Settings} onClick={() => onSettings(job)}>Settings</Button>
        <Button variant="outline" icon={ScrollText} onClick={() => onLog(job)}>Log</Button>
        {job.type === 'pipeline' ? (
          <Button variant="outline" icon={FolderOpen} onClick={() => onFiles(job)}>Files</Button>
        ) : null}
      </div>
    </section>
  )
}
