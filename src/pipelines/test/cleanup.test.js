import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupFiles, emptyTrash, listTrash, restoreTrashFiles, trashFile } from "../src/cleanup.js";
import { normalizeConfig } from "../src/config.js";
import { STATUS, Store } from "../src/store.js";

function makeCtx(root) {
  return {
    config: { trashDir: path.join(root, "trash") },
    log: () => {},
    notify: { notify: () => {} },
  };
}

async function exists(p) {
  return fsp.stat(p).then(() => true).catch(() => false);
}

test("trash records the origin and restore returns the file to it", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-trash-"));
  try {
    const sourceDir = path.join(root, "src");
    await fsp.mkdir(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "photo.jpg");
    await fsp.writeFile(source, "photo-data");
    const ctx = makeCtx(root);

    const trashPath = await trashFile(ctx, source, {
      sourceDir,
      folder: "Camera",
      destName: "2019-04-02-10-20-30-(photo).jpg",
    });
    assert.equal(await exists(source), false, "source should be moved away");
    assert.equal(await exists(trashPath), true);

    const entries = await listTrash(ctx);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, 1);
    assert.equal(entries[0].files[0].name, "photo.jpg");
    assert.equal(entries[0].files[0].sourceDir, sourceDir);
    assert.equal(entries[0].files[0].folder, "Camera");

    const results = await restoreTrashFiles(ctx, [{ day: entries[0].day, name: "photo.jpg" }]);
    assert.deepEqual(results.map((r) => r.ok), [true]);
    assert.equal(await fsp.readFile(source, "utf8"), "photo-data");
    assert.deepEqual(await listTrash(ctx), [], "trash should be empty after restore");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("restore without a recorded origin requires a target directory", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-trash-"));
  try {
    const ctx = makeCtx(root);
    const day = "2020-01-02";
    const dir = path.join(ctx.config.trashDir, day);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "mystery.bin"), "x");

    const entries = await listTrash(ctx);
    assert.equal(entries[0].files[0].sourceDir, null);

    const failed = await restoreTrashFiles(ctx, [{ day, name: "mystery.bin" }]);
    assert.equal(failed[0].ok, false);
    assert.match(failed[0].reason, /restore directory/);

    const target = path.join(root, "restored");
    const results = await restoreTrashFiles(ctx, [{ day, name: "mystery.bin" }], { targetDir: target });
    assert.deepEqual(results.map((r) => r.ok), [true]);
    assert.equal(await fsp.readFile(path.join(target, "mystery.bin"), "utf8"), "x");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite an existing file", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-trash-"));
  try {
    const sourceDir = path.join(root, "src");
    await fsp.mkdir(sourceDir, { recursive: true });
    const source = path.join(sourceDir, "photo.jpg");
    await fsp.writeFile(source, "original");
    const ctx = makeCtx(root);
    const trashPath = await trashFile(ctx, source, { sourceDir, folder: "Camera" });
    await fsp.writeFile(source, "replacement");

    const results = await restoreTrashFiles(ctx, [{ day: path.basename(path.dirname(trashPath)), name: "photo.jpg" }]);
    assert.equal(results[0].ok, false);
    assert.match(results[0].reason, /already exists/);
    assert.equal(await fsp.readFile(source, "utf8"), "replacement");
    assert.equal(await exists(trashPath), true, "trash copy must survive a blocked restore");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("emptyTrash removes all day directories", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-trash-"));
  try {
    const ctx = makeCtx(root);
    const day = path.join(ctx.config.trashDir, "2020-01-02");
    await fsp.mkdir(day, { recursive: true });
    await fsp.writeFile(path.join(day, "a.bin"), "x");
    await emptyTrash(ctx);
    assert.deepEqual(await listTrash(ctx), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("recursive cleanup verifies nested destinations and restores the subdirectory", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "file-pipelines-trash-"));
  try {
    await fsp.mkdir(path.join(root, "src", "sub"), { recursive: true });
    await fsp.mkdir(path.join(root, "dest", "sub"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "sub", "a.txt"), "nested");
    await fsp.writeFile(path.join(root, "dest", "sub", "a.txt"), "nested");
    const config = normalizeConfig({
      stagingDir: path.join(root, "staging"),
      reviewDir: path.join(root, "review"),
      trashDir: path.join(root, "trash"),
      logDir: path.join(root, "logs"),
      settleSeconds: 0,
      folders: [{
        name: "Camera",
        source: path.join(root, "src"),
        destination: path.join(root, "dest"),
        method: "copy",
        recursive: true,
        cleanup: true,
      }],
    });
    const store = new Store(config, null);
    await store.scanFolder("Camera");
    store.updateFile("Camera", "sub/a.txt", { status: STATUS.DONE, destName: "sub/a.txt" });
    const ctx = {
      config,
      store,
      log: () => {},
      notify: { notify: () => {} },
    };

    const results = await cleanupFiles(ctx, store.getFolder("Camera"), ["sub/a.txt"]);
    assert.deepEqual(results.map((result) => result.ok), [true]);
    assert.equal(await exists(path.join(root, "src", "sub", "a.txt")), false);

    const entries = await listTrash(ctx);
    assert.equal(entries[0].files[0].sourceDir, path.join(root, "src", "sub"));
    const restored = await restoreTrashFiles(ctx, [{ day: entries[0].day, name: entries[0].files[0].name }]);
    assert.deepEqual(restored.map((result) => result.ok), [true]);
    assert.equal(await fsp.readFile(path.join(root, "src", "sub", "a.txt"), "utf8"), "nested");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
