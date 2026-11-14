import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config.js";
import { STATUS, Store } from "../src/store.js";

test("store: a source that reappears after cleanup is processed again", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-store-"));
  try {
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const source = path.join(root, "src", "a.txt");
    await fsp.writeFile(source, "first");
    const config = normalizeConfig({
      stagingDir: path.join(root, "staging"),
      reviewDir: path.join(root, "review"),
      trashDir: path.join(root, "trash"),
      logDir: path.join(root, "logs"),
      settleSeconds: 0,
      folders: [{ name: "Camera", source: path.join(root, "src"), destination: path.join(root, "dest"), method: "copy", cleanup: true }],
    });
    const store = new Store(config, null);
    await store.scanFolder("Camera");
    store.updateFile("Camera", "a.txt", { status: STATUS.DONE });
    store.removeFile("Camera", "a.txt", STATUS.CLEANED);
    assert.equal(store.fileFor("Camera", "a.txt").status, STATUS.CLEANED);
    assert.ok(store.fileFor("Camera", "a.txt").updatedAt > 0);

    await fsp.writeFile(source, "second");
    store.addOrUpdate("Camera", "a.txt", await fsp.stat(source));
    assert.equal(store.fileFor("Camera", "a.txt").status, STATUS.PENDING);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
