import { load, recoverOwned, validateOwner } from './https-observe.mjs';
const expected = process.argv[2], d = await load();
validateOwner(d.meta.read(), expected);
process.send?.({ ready: expected });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (;;) {
  await sleep(500);
  const owner = d.meta.read();
  if (!owner || owner.id !== expected) break;
  validateOwner(owner, expected);
  const parentAlive = alive(owner.ownerPid);
  if (parentAlive && Date.now() < owner.deadline) continue;
  try {
    d.touchStop();
    recoverOwned(d, owner, { clear: !parentAlive });
    if (!parentAlive) break;
  } catch { await sleep(1000); }
}
