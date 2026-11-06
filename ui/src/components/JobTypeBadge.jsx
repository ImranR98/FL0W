import { Terminal, Webhook, Workflow } from 'lucide-react'

const TASK_LABELS = {
  command: 'Command',
  webhook: 'Webhook',
}

const PIPELINE_LABELS = {
  copy: 'Copy',
  standardize: 'Standardize',
  snapchat: 'Snapchat',
  'reviewed-audio': 'Reviewed audio',
}

export default function JobTypeBadge({ job }) {
  const isPipeline = job.type === 'pipeline'
  const typeLabel = isPipeline ? 'Pipeline' : 'Task'
  const labels = isPipeline ? PIPELINE_LABELS : TASK_LABELS
  const subtypeLabel = labels[job.subtype] ?? job.subtype ?? (isPipeline ? 'Pipeline' : 'Task')
  const Icon = isPipeline ? Workflow : job.subtype === 'webhook' ? Webhook : Terminal
  return (
    <span
      className={`job-type-badge job-type-badge--${isPipeline ? 'pipeline' : 'task'}`}
      data-testid={`job-type-${job.type}-${job.name}`}
    >
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
      {typeLabel} · {subtypeLabel}
    </span>
  )
}
