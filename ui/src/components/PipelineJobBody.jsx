import { Progress } from '@dscpln/ui-kit'

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

export default function PipelineJobBody({ job }) {
  const stats = countsFor(job)
  return (
    <div className="job-card__pipeline">
      <div className="job-card__paths">
        <code>{job.source}</code>
        <span aria-hidden="true">→</span>
        <code>{job.destination}</code>
      </div>
      <Progress
        value={stats.percent}
        tone={stats.errors ? 'over' : stats.pending ? 'warn' : 'ok'}
        label={`${job.name} progress`}
      />
      <div className="job-card__stats">
        <span><strong>{stats.pending}</strong> pending</span>
        <span><strong>{stats.review}</strong> review</span>
        <span><strong>{stats.processed}</strong> processed</span>
        <span><strong>{stats.errors}</strong> issues</span>
      </div>
      <p className="job-card__pace">
        {job.last_event_at ? `Last change ${new Date(job.last_event_at).toLocaleString()}` : 'Watching for files'}
      </p>
    </div>
  )
}
