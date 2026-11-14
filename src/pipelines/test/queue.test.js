import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config.js";
import { Queue } from "../src/queue.js";
import { Store } from "../src/store.js";

async function setup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-queue-"));
  for (const dir of ["src", "dest", "staging", "review", "trash", "logs"]) {
    await fsp.mkdir(path.join(root, dir), { recursive: true });
  }
  await fsp.writeFile(path.join(root, "src", "a.txt"), "a");
  await fsp.writeFile(path.join(root, "src", "b.txt"), "b");
  const config = normalizeConfig({
    stagingDir: path.join(root, "staging"),
    reviewDir: path.join(root, "review"),
    trashDir: path.join(root, "trash"),
    logDir: path.join(root, "logs"),
    settleSeconds: 0,
    concurrency: 2,
    notifySuccess: true,
    folders: [{
      name: "Camera",
      source: path.join(root, "src"),
      destination: path.join(root, "dest"),
      method: "copy",
      cleanup: false,
    }],
  });
  return { root, config };
}

test("queue: concurrent files share one run and per-run totals", async () => {
  const { root, config } = await setup();
  try {
    const store = new Store(config, null);
    await store.scanFolder("Camera");
    const starts = [];
    const ends = [];
    const notifications = [];
    const ctx = {
      config,
      store,
      exiftool: null,
      log: () => {},
      notify: { notify: async (level, message, options) => notifications.push({ level, message, options }) },
      onJobStart: (name, meta) => starts.push({ name, meta }),
      onJobEnd: (name, stats) => ends.push({ name, stats }),
    };
    const queue = new Queue(ctx);
    ctx.queue = queue;
    queue.tick();
    for (let i = 0; i < 100 && ends.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(starts.length, 1, "one run starts for the folder");
    assert.equal(ends.length, 1, "one run ends after both files finish");
    assert.deepEqual(ends[0].stats, { processed: 2, review: 0, issues: 0 });
    assert.equal(queue.active.has("Camera"), false);
    assert.equal(queue.running, 0);
    assert.equal(notifications.filter((entry) => entry.level === "info").length, 2);
    assert.ok(notifications.every((entry) => entry.options?.batchKey === "Camera"));
    assert.equal((await fsp.readdir(path.join(root, "dest"))).length, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
