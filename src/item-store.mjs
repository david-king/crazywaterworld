// 协议里没有获得时间字段，只有 uid，所以只能记录第一次读到它的时刻。
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './json-store.mjs';
import { dataDirectory } from './usage-ledger.mjs';

export function itemsStatePath(accountId) {
  return path.join(dataDirectory(), 'items', encodeURIComponent(String(accountId)) + '.json');
}

export function syncItems(accountId, rows, now = Date.now()) {
  const file = itemsStatePath(accountId);
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8'))?.items ?? {};
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const items = {};
  for (const row of rows) {
    const key = row.kind + ':' + row.uid;
    const firstSeen = previous[key]?.firstSeen;
    row.firstSeen = Number.isFinite(firstSeen) ? firstSeen : now;
    items[key] = { firstSeen: row.firstSeen };
  }
  atomicJson(file, { version: 1, items });
}
