import fs from 'node:fs';
import path from 'node:path';

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
export function writeJsonAtomic(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** Small per-plugin JSON KV with debounced persistence. */
export class JsonKV<T extends Record<string, unknown>> {
  data: T; private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, initial: T) { this.data = readJson(file, initial); }
  save(delayMs = 1000) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delayMs);
  }
  flush() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } writeJsonAtomic(this.file, this.data); }
}
