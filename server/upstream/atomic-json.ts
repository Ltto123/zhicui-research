import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const windowsRenameDelays = [10, 25, 50, 100, 200];
const renameWait = new Int32Array(new SharedArrayBuffer(4));

/** A local persistence failure cannot be repaired by another model request. */
export class AtomicJsonWriteError extends Error {
  readonly code?: string;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AtomicJsonWriteError';
    this.code = (cause as NodeJS.ErrnoException | undefined)?.code;
  }
}

function renameAtomically(source: string, destination: string): void {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows indexers and antivirus can briefly hold a reader's handle. Keep
      // the previous complete file in place; never emulate rename with unlink.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= windowsRenameDelays.length) throw error;
      Atomics.wait(renameWait, 0, 0, windowsRenameDelays[attempt]);
    }
  }
}

/**
 * Write JSON durably: temp file in the same directory, fsync the data, then a
 * same-directory rename so readers never observe a partial document and a
 * power loss cannot surface an empty file under the final name.
 */
export function atomicJson(file: string, value: unknown, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const data = JSON.stringify(value, null, 2) + "\n";
  let created = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, "wx", mode);
    created = true;
    try {
      fs.writeFileSync(fd, data, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameAtomically(tmp, file);
  } catch (error) {
    // Only this invocation's unpublished temporary file is disposable.
    if (created) try { fs.unlinkSync(tmp); } catch { /* Preserve the original write error. */ }
    throw new AtomicJsonWriteError(error);
  }
}
