import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDirectory } from './usage-ledger.mjs';
import { readJson, atomicJson, withFileLock } from './json-store.mjs';
import { goldAccountKey } from './gold-reservations.mjs';

function fileFor(player) {
  const role = createHash('sha256').update(goldAccountKey(player)).digest('hex');
  return path.join(dataDirectory(), 'factory-insertions', role + '.json');
}

export function factoryInsertions(player) {
  if (!player?.playerId || !player.worldId) return {};
  return readJson(fileFor(player), {});
}

export function saveFactoryInsertion(player, buildingId, previous, next, quotedEntries, supplies = {}) {
  const file = fileFor(player);
  return withFileLock(file, () => {
    const entries = readJson(file, {});
    if (entries[buildingId]?.revision !== previous?.revision) throw new Error('工厂插单已变化，请重新生成计划');
    if (quotedEntries && (Object.keys(quotedEntries).length !== Object.keys(entries).length
      || Object.keys(entries).some(id => entries[id].revision !== quotedEntries[id]?.revision))) {
      throw new Error('其他插单的库存预留已变化，请重新选择数量');
    }
    if (next) entries[buildingId] = { ...next, revision: randomUUID() };
    else delete entries[buildingId];
    for (const [id, jobs] of Object.entries(supplies)) {
      const entry = entries[id];
      if (id === buildingId || entry?.flight || entry?.remove?.length || entry?.stagedSupplies) {
        throw new Error('上游队列正在调整，等待核对后补料');
      }
      entries[id] = {jobs:[...jobs, ...(entry?.jobs ?? [])], revision:randomUUID()};
    }
    atomicJson(file, entries);
    return entries[buildingId];
  });
}
