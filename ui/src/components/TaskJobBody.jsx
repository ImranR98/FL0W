import { X } from 'lucide-react'
import { Button, Dropzone } from '@dscpln/ui-kit'

const browserSrcFor = () => `${window.DSCPLN_TASK_BASE ?? '.'}/browser/?autoconnect=1&resize=scale&reconnect=1&path=websockify`

export default function TaskJobBody({
  task,
  preparing = {},
  uploading,
  queues,
  browserAvailable,
  openBrowsers,
  onToggleBrowser,
  onQueueFiles,
  onRemoveQueued,
}) {
  const files = queues[task.name] ?? []
  const isPreparing = preparing[task.name] != null
  const isUploading = uploading[task.name] != null
  const uploadPercent = isPreparing ? preparing[task.name] : uploading[task.name]
  const browserSrc = browserSrcFor()

  return (
    <div className="job-card__task">
      {task.live && task.running ? <div className="card-live">{task.live}</div> : null}

      {isPreparing || isUploading ? (
        <div className="upload-bar"><div className="upload-fill" style={{ width: `${Math.round(uploadPercent)}%` }}></div></div>
      ) : null}

      {task.uploads ? (
        <>
          <Dropzone
            onFiles={(dropped) => onQueueFiles(task, dropped)}
            label={task.note || 'Drop files here or choose files'}
            hint={task.note ? null : 'Files are queued until you press Run'}
          />
          {files.length ? (
            <div className="queue-list">
              {files.map((file) => (
                <div className="queue-item" key={file.name}>
                  <span className="queue-name">{file.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={X}
                    aria-label={`Remove ${file.name} from queue`}
                    title="Remove from queue"
                    onClick={() => onRemoveQueued(task, file)}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : task.note ? (
        <div className="card-note">{task.note}</div>
      ) : null}

      {task.browser && browserAvailable ? (
        <div className="browser-block">
          <div className="browser-actions">
            <Button variant="outline" onClick={() => onToggleBrowser(task.name)}>
              {openBrowsers[task.name] ? 'Hide login browser' : 'Open login browser'}
            </Button>
            <a className="browser-newtab" href={browserSrc} target="_blank" rel="noreferrer">New tab</a>
          </div>
          {openBrowsers[task.name] ? (
            <iframe className="browser-frame" title={`${task.name} login browser`} src={browserSrc}></iframe>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
