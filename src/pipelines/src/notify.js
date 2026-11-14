// File Pipelines notifications: thin level-based wrapper over the shared kit
// Notifier. Delivery goes through the DA5H relay (NOTIFY_RELAY_URL); the
// portal owns the ntfy URL + token and titles/auth/header sanitizing stay
// uniform across apps.
//
// Successful file notifications are coalesced per folder. A burst of camera
// imports becomes one message after the quiet window instead of one request
// per file, which otherwise trips ntfy's rate limit. Warnings and errors are
// always sent immediately.

import { clickFor, Notifier as KitNotifier } from "@dscpln/server-kit";

const LEVELS = {
  error: { priority: "high", tags: ["warning"] },
  warn: { priority: "default", tags: ["warning"] },
  info: { priority: "low", tags: ["white_check_mark"] },
};

const DEFAULT_BATCH_QUIET_MS = 3_000;
const DEFAULT_BATCH_MAX_MS = 30_000;
const DEFAULT_MAX_BATCH_LINES = 8;
const MAX_MESSAGE_LENGTH = 3_800;

export class Notifier {
  constructor(config, log, options = {}) {
    this.log = log;
    this.batchQuietMs = Math.max(0, Number(options.batchQuietMs ?? DEFAULT_BATCH_QUIET_MS));
    this.batchMaxMs = Math.max(0, Number(options.batchMaxMs ?? DEFAULT_BATCH_MAX_MS));
    this.maxBatchLines = Math.max(1, Number(options.maxBatchLines ?? DEFAULT_MAX_BATCH_LINES));
    this.pending = new Map();
    this.inner = new KitNotifier({ app: "File Pipelines" }, (line) => log.log(line));
    this.setConfig(config);
  }

  setConfig(config) {
    this.notifySuccess = config.notifySuccess !== false;
    this.inner.setConfig({
      app: "File Pipelines",
      relayUrl: process.env.NOTIFY_RELAY_URL ?? process.env.DSCPLN_PORTAL_URL ?? "",
      click: clickFor(process.env.BASE_PATH ?? ""),
    });
    if (!this.notifySuccess) this.#clearPending();
  }

  async notify(level, message, { batchKey = null } = {}) {
    if (level === "info" && !this.notifySuccess) return { ok: true, skipped: true };
    if (level !== "info") {
      // Keep ordering understandable: show the pending successes for this
      // folder before the failure that arrived after them.
      if (batchKey) await this.#flush(String(batchKey));
      return this.#send(level, message);
    }
    if (!batchKey) return this.#send(level, message);
    this.#queueBatch(String(batchKey), String(message));
    return { ok: true, queued: true };
  }

  async flush() {
    await Promise.all([...this.pending.keys()].map((key) => this.#flush(key)));
  }

  #queueBatch(key, message) {
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { messages: [], quietTimer: null, maxTimer: null };
      this.pending.set(key, entry);
      entry.maxTimer = setTimeout(() => {
        this.#flush(key).catch(() => {});
      }, this.batchMaxMs);
      entry.maxTimer.unref?.();
    }
    entry.messages.push(message);
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    entry.quietTimer = setTimeout(() => {
      this.#flush(key).catch(() => {});
    }, this.batchQuietMs);
    entry.quietTimer.unref?.();
  }

  async #flush(key) {
    const entry = this.pending.get(key);
    if (!entry) return { ok: true, skipped: true };
    this.pending.delete(key);
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    if (!entry.messages.length) return { ok: true, skipped: true };
    if (!this.notifySuccess) return { ok: true, skipped: true };
    const message = entry.messages.length === 1
      ? entry.messages[0]
      : this.#batchMessage(key, entry.messages);
    return this.#send("info", message);
  }

  #batchMessage(key, messages) {
    const prefix = `${key}: `;
    const lines = messages
      .slice(0, this.maxBatchLines)
      .map((message) => (message.startsWith(prefix) ? message.slice(prefix.length) : message))
      .map((line) => line.replace(/\s+/g, " ").trim().slice(0, 180));
    const remaining = messages.length - lines.length;
    const header = `${key}: ${messages.length} update${messages.length === 1 ? "" : "s"}`;
    let text = [header, ...lines.map((line) => `• ${line}`)].join("\n");
    if (remaining > 0) text += `\n…and ${remaining} more`;
    return text.length > MAX_MESSAGE_LENGTH
      ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
      : text;
  }

  async #send(level, message) {
    const { priority, tags } = LEVELS[level] ?? LEVELS.info;
    const result = await this.inner.notify(message, {
      title: "FL0W - Pipelines",
      priority,
      tags,
    });
    if (!result.ok && this.inner.configured) this.log.log(`notification failed: ${result.error}`);
    return result;
  }

  #clearPending() {
    for (const entry of this.pending.values()) {
      if (entry.quietTimer) clearTimeout(entry.quietTimer);
      if (entry.maxTimer) clearTimeout(entry.maxTimer);
    }
    this.pending.clear();
  }
}
