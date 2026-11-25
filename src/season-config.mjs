import { uidText } from './hero-equipment.mjs';

export function seasonOf(player) {
  const world = uidText(player?.worldId);
  return world ? Number(BigInt(world) / 1_000_000n % 1000n) : 0;
}

// 同一张表中，后一组配置从其赛季起整组替换前一组。海盗表的赛季编号是字符串。
export function rowsForSeason(rows, season, { includeCommon = false } = {}) {
  let latest = 0;
  for (const row of rows) {
    const value = Number(row.season);
    if (Number.isSafeInteger(value) && value > latest && value <= season) latest = value;
  }
  return rows.filter(row => row.season == null ? includeCommon : latest > 0 && Number(row.season) === latest);
}

export function seasonRows(config, table, player, options) {
  return rowsForSeason(config?.tables?.[table]?.data ?? [], seasonOf(player), options);
}
