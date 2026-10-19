// Patch @fluxerjs/ws 3.1.0: reconnect paths close with 1000, which makes the Fluxer gateway
// destroy the session (verified against a live Fluxer instance, Oct 2026), so RESUME always fails.
// Rewrite every reconnect-path close(1e3) to close(4000); keep destroy() at 1000 (deliberate shutdown).
import fs from 'node:fs';
const EXPECTED_VERSION = '3.1.0';
const dir = new URL('../node_modules/@fluxerjs/ws/', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', dir)));
if (pkg.version !== EXPECTED_VERSION) {
  console.error(`patch: @fluxerjs/ws is ${pkg.version}, expected ${EXPECTED_VERSION}; review the patch`); process.exit(1);
}
for (const f of ['dist/index.js', 'dist/index.mjs']) {
  const p = new URL(f, dir);
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes('/* fluxer-agent-bridge patched */')) { console.log(`patch: ${f} already patched`); continue; }
  const destroyRe = /(destroy\(\) \{\s*this\.phase = Phase\.Destroyed;\s*this\.clearReconnectTimer\(\);\s*this\.stopHeartbeat\(\);\s*this\.ws\?\.close\()1e3(\);)/;
  if (!destroyRe.test(src)) { console.error(`patch: destroy() pattern not found in ${f}`); process.exit(1); }
  src = src.replace(destroyRe, '$1__KEEP1000__$2');
  const n = (src.match(/close\(1e3\)/g) || []).length;
  if (n !== 4) { console.error(`patch: expected 4 reconnect-path close(1e3) in ${f}, found ${n}`); process.exit(1); }
  src = src.replace(/close\(1e3\)/g, 'close(4e3)').replace('__KEEP1000__', '1e3');
  fs.writeFileSync(p, '/* fluxer-agent-bridge patched */\n' + src);
  console.log(`patch: ${f}: 4 reconnect closes -> 4000, destroy() kept at 1000`);
}
