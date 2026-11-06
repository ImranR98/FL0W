import { FolderSearch, RefreshCw } from 'lucide-react'

const countText = (counts = {}) => {
  const pending = (counts.pending ?? 0) + (counts.queued ?? 0) + (counts.processing ?? 0)
  const review = counts.review ?? 0
  const errors = (counts.error ?? 0) + (counts.conflict ?? 0)
  return { pending, review, errors }
}

export default function PipelineCard({ job, onRun, onOpen }) {
  const counts = countText(job.counts)
  const pill = job.running ? 'running' : counts.errors ? 'fail' : counts.pending ? 'warn' : 'neutral'
  return (
    <section className="card pipeline-job-card" data-testid={`pipeline-${job.name}`}>
      <div className="card__header">
        <h2 className="card-title">{job.name}</h2>
        <span className={`pill pill--${pill}`}>
          {job.running ? 'Processing…' : counts.errors ? `${counts.errors} issue${counts.errors === 1 ? '' : 's'}` : counts.pending ? `${counts.pending} pending` : 'Idle'}
        </span>
      </div>
      <p className="pipeline-job-card__method">{job.method}{job.exists === false ? ' · source unavailable' : ''}</p>
      <div className="pipeline-job-card__paths">
        <span title={job.source}>{job.source}</span>
        <span aria-hidden="true">→</span>
        <span title={job.destination}>{job.destination}</span>
      </div>
      <div className="pipeline-job-card__stats">
        <span><strong>{counts.pending}</strong> pending</span>
        <span><strong>{counts.review}</strong> review</span>
        <span><strong>{job.fileCount ?? 0}</strong> files</span>
      </div>
      <div className="pipeline-job-card__actions">
        <button type="button" onClick={() => onRun(job)} disabled={job.running || job.exists === false}>
          <RefreshCw size={15} strokeWidth={1.8} /> Process now
        </button>
        <a className="outline secondary button-link" href={onOpen}>
          <FolderSearch size={15} strokeWidth={1.8} /> Full pipeline view
        </a>
      </div>
    </section>
  )
}
