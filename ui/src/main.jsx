import '@dscpln/ui-kit/app.css'
import '../../src/tasks/ui/src/task-runner.css'
import '../../src/pipelines/ui/src/file-pipelines.css'
import './fl0w.css'
import { applyBrand, mountApp } from '@dscpln/ui-kit'
import App from './App.jsx'

window.DSCPLN_TASK_BASE = '/tasks'
applyBrand('fl0w')
mountApp(App)
