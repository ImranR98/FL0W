import { FolderSearch, RefreshCw } from 'lucide-react'
import { Button, Progress, StatusPill } from '@dscpln/ui-kit'

const countsFor = (job) => {
  const counts = job.counts ?? {}
  const total = job.fileCount ?? Object.values(counts).reduce((sum, value) => sum + value, 0)
  const pending = job.pending ?? ((counts.pending ?? 0) + (counts.queued ?? 0) + (counts.processing ?? 0))
  const review = job.review ?? counts.review ?? 0
  const errors = job.errors ?? ((counts.error ?? 0) + (counts.conflict ?? 0))
  const processed = (counts.done ?? 0) + (counts.duplicate ?? 0)
  const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0
  return { total, pending, review, errors, processed, percent }
}

export default function PipelineCard({ job, onRun, onOpen }) {
  const stats = countsFor(job)
  const tone = job.running ? 'running' : stats.errors ? 'danger' : stats.pending ? 'warn' : job.enabled === false ? 'neutral' : 'ok'
  const status = job.running ? 'Running' : stats.errors ? `${stats.errors} issue${stats.errors === 1 ? '' : 's'}` : stats.pending ? `${stats.pending} pending` : 'Idle'
  return (
    <section className="card job-card pipeline-card" data-testid={`pipeline-${job.name}`}>
      <div className="card__header">
        <h2 className="card-title">{job.name}</h2>
        <StatusPill tone={tone}>{status}</StatusPill>
      </div>
      <p className="pipeline-card__method">{job.method}{job.exists === false ? ' · source unavailable' : ''}</p>
      <div className="pipeline-card__paths">
        <code>{job.source}</code>
        <span aria-hidden="true">→</span>
        <code>{job.destination}</code>
      </div>
      <Progress value={stats.percent} tone={stats.errors ? 'over' : stats.pending ? 'warn' : 'ok'} label={`${job.name} progress`} />
      <div className="pipeline-card__stats">
        <span><strong>{stats.pending}</strong> pending</span>
        <span><strong>{stats.review}</strong> review</span>
        <span><strong>{stats.processed}</strong> processed</span>
        <span><strong>{stats.errors}</strong> issues</span>
      </div>
      <p className="pipeline-card__pace">
        {job.last_event_at ? `Last change ${new Date(job.last_event_at).toLocaleString()}` : 'Watching for files'}
      </p>
      <div className="pipeline-card__actions">
        <Button variant="outline" icon={RefreshCw} onClick={() => onRun(job)} disabled={job.running || job.exists === false || job.enabled === false}>
          Process now
        </Button>
        <Button variant="outline" icon={FolderSearch} onClick={() => onOpen(job)}>
          Open pipeline
        </Button>
      </div>
    </section>
  )
}
