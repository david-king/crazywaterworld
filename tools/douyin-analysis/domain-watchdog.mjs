// Detached recovery helper for the metadata-only observer. Never opens a listener or installs a CA.
import { loadDependencies, restoreRecord, validateRecord } from './domain-discovery.mjs';

const expectedId = process.argv[2];
const d = await loadDependencies();
let record = d.journal.read();
validateRecord(record, expectedId);
process.send?.({ ready: expectedId });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (;;) {
  await sleep(500);
  record = d.journal.read();
  if (!record || record.id !== expectedId) break;
  validateRecord(record, expectedId);
  const parentAlive = alive(record.ownerPid);
  if (parentAlive && Date.now() < record.deadline) continue;
  // Exact run id and snapshot ownership prevent overwriting another routing choice.
  // The parent's normal cleanup is idempotent with this deadline/exit fallback.
  // Keep the recovery journal while the writer is alive: a slow registry write
  // must not resurrect the proxy after the watchdog has already exited.
  try { restoreRecord(d, record, expectedId, { clear: !parentAlive }); if (!parentAlive) break; }
  catch { await sleep(1000); }
}
