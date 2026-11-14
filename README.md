# FL0W

**One place for scheduled tasks and file pipelines.**

FL0W merges the old Task Runner and File Pipelines apps into one job model:

- **Task jobs** run shell commands on a schedule or on demand, with uploads,
  prompts, actions, webhooks and the optional login browser.
- **Pipeline jobs** watch folders, standardize/copy media, park items for
  review, and move originals to trash only after verifying the destination.
- Both appear in one jobs list with shared schedules, run state, logs and
  notifications. Task notifications are per run; pipeline file successes are
  coalesced per folder, while warnings and failures notify immediately.
  Pipeline jobs can also be scheduled.

The unified UI lives at `/`; it covers task actions, uploads, the login
browser, pipeline review, cleanup, trash and job settings. `/tasks` and
`/pipelines` redirect there. Their APIs remain mounted for uploads, browser
access and pipeline file actions. Use the Type filter, collapsible groups or
Comfortable/Compact density to keep the list short.

## Layout

```text
src/
  server.mjs              unified server, job API, schedules and mounts
  tasks/                  task engine (commands, uploads, webhooks, browser)
  pipelines/              file pipeline engine (watchers, queue, review, trash)
  agent/                  optional remote archive agent
ui/                       unified jobs UI
config/                   gitignored clone of fl0w-config
kit/                      shared DSCPLN-KIT submodule
docker/                   app + agent images
```

## Configuration

Clone the private config repo into `config/`:

```sh
git clone --recurse-submodules git@github.com:ImranR98/fl0w-config.git config
```

The app reads:

| Setting | Default | Purpose |
|---|---|---|
| `FL0W_CONFIG` / `BACKUPCTL_CONFIG_FILE` | `config/config.mjs` | Task job definitions |
| `FL0W_PIPELINES_CONFIG` | `config/apps/file-pipelines/config.json` | Pipeline jobs and engine settings |
| `FL0W_STATE_DIR` / `BACKUPCTL_STATE_DIR` | `config/.state` | Run state, schedules and staging |
| `NOTIFY_RELAY_URL` | — | DA5H notification relay |
| `APP_ORIGIN` | — | Public URL used in notification links |
| `BROWSER_REMOTE` | — | Login-browser sidecar (noVNC) |

`config.example.mjs` and `config.example.json` show the shapes. Secrets stay in
`config/secrets.json` (gitignored) and are referenced from `config.mjs`.

## Unified API

```text
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/run
POST /api/jobs/:id/cancel
GET  /api/jobs/:id/runs
GET  /api/jobs/:id/log
GET  /api/state
GET  /api/metrics
```

Job ids are `task:<name>` and `pipeline:<name>`; a bare unique name still works.
Task-specific endpoints stay under `/tasks/api/*`; pipeline-specific endpoints
stay under `/pipelines/api/*`.

## Development

```sh
npm install
git submodule update --init --recursive
mkdir -p config
cp config.example.mjs config/config.mjs
cp config.example.json config/apps/file-pipelines/config.json
npm run build:ui
npm start
```

Open <http://localhost:8085>. The agent image is
`ghcr.io/imranr98/fl0w-agent`; the GTK variant is `fl0w-agent-gtk`.
