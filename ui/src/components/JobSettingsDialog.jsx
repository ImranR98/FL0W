import { useMemo, useState } from 'react'
import { Button, Dialog, Field } from '@dscpln/ui-kit'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// One dialog for the metadata every job shares: attributes, schedule,
// notifications and enabled state. Type-specific settings (pipeline paths,
// task commands) live with their executor.
export default function JobSettingsDialog({ job, attributes, onClose, onSave }) {
  const schedule = job.schedule ?? {}
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(schedule.enabled))
  const [daily, setDaily] = useState(!(schedule.days?.length))
  const [days, setDays] = useState(new Set(schedule.days ?? []))
  const [at, setAt] = useState(schedule.at ?? '05:00')
  const [catchUp, setCatchUp] = useState(schedule.catchUp !== false)
  const [jobEnabled, setJobEnabled] = useState(job.enabled !== false)
  const [notify, setNotify] = useState(job.notify ?? 'never')
  const values = useMemo(() => ({ ...(job.attributes ?? {}) }), [job])
  const [jobAttributes, setJobAttributes] = useState(values)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const canSchedule = job.capabilities?.schedule ?? job.schedulable

  const toggleDay = (day, checked) => {
    setDays((currentDays) => {
      const next = new Set(currentDays)
      if (checked) next.add(day)
      else next.delete(day)
      return next
    })
  }

  const attributeValues = (attribute) => {
    const list = [...(attribute.values ?? [])]
    const selected = jobAttributes[attribute.name]
    if (selected && !list.includes(selected)) list.push(selected)
    return list
  }

  const save = async () => {
    setError('')
    if (canSchedule && scheduleEnabled && !daily && days.size === 0) {
      setError('Choose at least one day, or select Every day.')
      return
    }
    if (canSchedule && scheduleEnabled && !/^\d{2}:\d{2}$/.test(at)) {
      setError('Choose a valid time.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        attributes: jobAttributes,
        enabled: jobEnabled,
        notify,
      }
      if (canSchedule) {
        payload.schedule = {
          enabled: scheduleEnabled,
          days: daily ? [] : [...days].sort((a, b) => a - b),
          at,
          catchUp,
        }
      }
      await onSave(payload)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      className="wide-dialog"
      title={`Settings: ${job.name}`}
      onClose={onClose}
      requestClose={onClose}
      actions={(
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</Button>
        </>
      )}
    >
      <div className="settings-body">
        <section className="settings-section">
          <h3>Job</h3>
          <label className="schedule-toggle">
            <input type="checkbox" checked={jobEnabled} onChange={(event) => setJobEnabled(event.target.checked)} />
            <span>Enabled</span>
          </label>
          {job.type === 'pipeline' ? (
            <p className="hint">Pipeline notifications are configured per folder in Pipeline settings.</p>
          ) : (
            <Field label="Notifications" htmlFor="job-notify" hint="Failures always notify; “always” also sends successful runs.">
              <select id="job-notify" value={notify} onChange={(event) => setNotify(event.target.value)}>
                <option value="never">Never</option>
                <option value="errors">On failure</option>
                <option value="always">Always</option>
              </select>
            </Field>
          )}
        </section>

        <section className="settings-section">
          <h3>Attributes</h3>
          {attributes.length ? (
            <div className="attribute-editor">
              {attributes.map((attribute) => (
                <Field key={attribute.name} label={attribute.name} htmlFor={`job-attribute-${attribute.name}`}>
                  <select
                    id={`job-attribute-${attribute.name}`}
                    value={jobAttributes[attribute.name] ?? ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setJobAttributes((currentValues) => {
                        const next = { ...currentValues }
                        if (value) next[attribute.name] = value
                        else delete next[attribute.name]
                        return next
                      })
                    }}
                  >
                    <option value="">Unassigned</option>
                    {attributeValues(attribute).map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          ) : <p className="hint">No attributes are defined.</p>}
        </section>

        <section className="settings-section">
          <h3>Schedule</h3>
          {canSchedule ? (
            <div className="schedule-editor">
              <label className="schedule-toggle">
                <input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} />
                <span>Run this job automatically on a schedule</span>
              </label>

              <Field label="Time" htmlFor="job-schedule-time" hint="Local time on the FL0W instance.">
                <input id="job-schedule-time" type="time" value={at} onChange={(event) => setAt(event.target.value)} />
              </Field>

              <div className="field">
                <span className="field__label">Days</span>
                <label className="schedule-toggle">
                  <input type="checkbox" checked={daily} onChange={(event) => setDaily(event.target.checked)} />
                  <span>Every day</span>
                </label>
                {!daily ? (
                  <div className="schedule-days">
                    {DAYS.map((label, day) => (
                      <label key={label} className="schedule-day">
                        <input type="checkbox" checked={days.has(day)} onChange={(event) => toggleDay(day, event.target.checked)} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>

              <label className="schedule-toggle">
                <input type="checkbox" checked={catchUp} onChange={(event) => setCatchUp(event.target.checked)} />
                <span>Catch up a missed run when FL0W comes back</span>
              </label>
            </div>
          ) : (
            <p className="hint">This job needs manual input or browser interaction, so it cannot be scheduled.</p>
          )}
        </section>

        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </Dialog>
  )
}
