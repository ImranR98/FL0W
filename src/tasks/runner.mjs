// Subprocess layer: spawn commands in their own process groups with output
// streaming/capture, secret redaction and cancel-by-pid-group.

import os from 'node:os';
import { spawn } from 'node:child_process';
import { redactText, shellQuote, splitLines } from './util.mjs';

export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1 * 1024 * 1024;

// subprocess layer -----------------------------------------------------------

export function killpg(pid, log = () => {}) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch { /* already gone or not permitted */ }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch { /* already gone */ }
  }, 1000);
  log('(killed)');
}

function spawnSafe(cmd, opts = {}) {
  const { cwd, shell = false, env = {}, uid, gid } = opts;
  let file;
  let args;
  if (Array.isArray(cmd)) {
    [file, args] = [cmd[0], cmd.slice(1)];
  } else if (shell) {
    /* Commands are documented as bash. spawn(..., { shell: true }) would use
     * /bin/sh, which is dash on Debian and lacks `source`, `[[`, etc. */
    file = 'bash';
    args = ['-c', cmd];
  } else {
    file = cmd;
    args = [];
  }
  return spawn(file, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...env },
    // A task can opt into the host data owner's UID/GID; the parent retains
    // root + CAP_SETUID/CAP_SETGID so backup tasks can still read all PVCs.
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* Run a command (argv list or shell string). By default output lines are
 * streamed into log() and the exit code is returned; with `capture: true`
 * all output is buffered and {rc, out, err} is returned instead. Spawned
 * pids are registered in `groups` (default: a throwaway set) so a
 * per-run cancel can kill exactly this run's process groups; redact masks
 * secrets in the logged command and output. No automatic timeout — runs
 * end when the command exits or is cancelled. */
export function run(cmd, opts = {}) {
  const { shell = false, cwd, log = () => {}, redact = [], capture = false, env = {}, groups = new Set(), uid, gid } = opts;
  log(`$ ${redactText(shell ? cmd : cmd.map(shellQuote).join(' '), redact)}`);
  let proc;
  const outBuf = [];
  const errBuf = [];
  let outBytes = 0;
  let errBytes = 0;
  let outTruncated = false;
  let errTruncated = false;
  const finishText = (chunks, truncated, limit, redactValues) => {
    const text = redactText(chunks.join(''), redactValues);
    return truncated ? `${text}\n[output truncated at ${limit} bytes]` : text;
  };
  const done = (rc) => (capture
    ? {
      rc,
      out: finishText(outBuf, outTruncated, MAX_CAPTURE_BYTES, redact),
      err: finishText(errBuf, errTruncated, MAX_STDERR_BYTES, redact),
    }
    : rc);
  try {
    proc = spawnSafe(cmd, { cwd, shell, env, uid, gid });
  } catch (e) {
    log(`ERROR: could not start: ${e.message}`);
    return Promise.resolve(capture ? { rc: 127, out: '', err: String(e) } : 127);
  }
  proc.stdout.on('error', () => {});
  proc.stderr.on('error', () => {});
  proc.stdout.on('data', (d) => {
    if (capture) {
      const room = MAX_CAPTURE_BYTES - outBytes;
      if (room > 0) outBuf.push(room >= d.length ? d : d.subarray(0, room));
      outBytes += Math.min(room, d.length);
      if (d.length > room) outTruncated = true;
      return;
    }
    // terminal-faithful line splitting: '\r' (progress updates) and '\n'
    // both end a line; the trailing partial line is flushed on close
    outTail += d;
    let idx;
    while ((idx = outTail.search(/[\r\n]/)) !== -1) {
      log(redactText(outTail.slice(0, idx), redact));
      const skip = outTail[idx] === '\r' && outTail[idx + 1] === '\n' ? 2 : 1;
      outTail = outTail.slice(idx + skip);
    }
  });
  proc.stderr.on('data', (d) => {
    const room = MAX_STDERR_BYTES - errBytes;
    if (room > 0) errBuf.push(room >= d.length ? d : d.subarray(0, room));
    errBytes += Math.min(room, d.length);
    if (d.length > room) errTruncated = true;
  });
  groups.add(proc.pid);
  let outTail = '';
  return new Promise((resolvePromise) => {
    let settled = false;
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      log(`ERROR: could not start: ${e.message}`);
      groups.delete(proc.pid);
      resolvePromise(capture ? { rc: 127, out: finishText(outBuf, outTruncated, MAX_CAPTURE_BYTES, redact), err: finishText(errBuf, errTruncated, MAX_STDERR_BYTES, redact) } : 127);
    });
    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      groups.delete(proc.pid);
      const rc = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
      if (!capture) {
        if (outTail) log(redactText(outTail, redact));
        // stderr is buffered and flushed here (nothing is lost to the pipe race)
        for (const line of splitLines(finishText(errBuf, errTruncated, MAX_STDERR_BYTES, redact))) log(line);
      }
      resolvePromise(done(rc));
    });
  });
}

export function sh(cmd, opts = {}) {
  return run(cmd, { ...opts, shell: true });
}

/* Run a shell command capturing all output. Returns {rc, out, err}. */
export function shCapture(cmd, opts = {}) {
  return run(cmd, { ...opts, shell: true, capture: true });
}

export function makeLogger() {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  log.text = () => lines.join('\n');
  return log;
}
