import { toNumber } from './client.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { formationSignature } from './saved-lineups.mjs';

const infoOf = client => client.request('LeagueInfoRequest', {}, 'LeagueInfoResponse');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const recoveryKey = player => 'league-order:' + uidText(player.worldId) + ':' + uidText(player.playerId);
const positive = value => Number.isSafeInteger(value) && value > 0;
const orders = { 2: [[1, 2], [2, 1]], 3: [[1, 2, 3], [1, 3, 2], [2, 1, 3], [3, 2, 1], [2, 3, 1], [3, 1, 2]] };

export function leagueFormationOrder(info, count, player) {
  if (!uidText(player.playerId) || uidText(info.mine?.playerId) !== uidText(player.playerId)) throw Error('积分赛角色已变化');
  const teams = [...(info.ownFormations ?? [])].sort((a, b) => a.index - b.index);
  if (!orders[count] || teams.length !== count || teams.some((t, i) => t.index !== i + 1 || !t.heroPositions?.length)) {
    throw Error('请先配齐本段位的积分赛队伍');
  }
  const signature = teams.map(formationSignature);
  if (new Set(signature).size !== count) throw Error('无法区分积分赛队伍');
  return { teams, signature };
}

export async function leagueTeamPowers(client, teams) {
  const { heroes } = await client.request('AllHeroRequest', {}, 'AllHeroResponse');
  const roster = new Map(heroes.map(hero => [hero.heroId, toNumber(hero.power)]));
  return teams.map(team => {
    const values = team.heroPositions.map(slot => roster.get(slot.heroId));
    const total = values.reduce((sum, power) => sum + power, 0);
    if (!values.every(positive) || !positive(total)) throw Error('积分赛英雄战力尚未同步');
    return total;
  });
}

export async function rivalTeamPowers(client, id, count) {
  const { formation } = await client.request('LeagueOtherFormationRequest', { playerId: wireUid(id) }, 'LeagueOtherFormationResponse');
  const powers = formation?.map(team => toNumber(team.power));
  return powers?.length === count && powers.every(positive) ? powers : null;
}

// Equal powers provide no evidence of a win. Try the current order first so a tie never forces a swap.
export function bestLeagueOrder(own, rival) {
  let best;
  for (const order of orders[own.length]) {
    const wins = order.filter((index, slot) => own[index - 1] > rival[slot]).length;
    if (!best || wins > best.wins) best = { order, wins };
  }
  return best;
}

const permute = (items, order) => order.map(index => items[index - 1]);

async function writeOrder(client, order, expected, player, enabled) {
  await client.request('LeagueFormationSequenceRequest', { index: order }, 'LeagueFormationResponse', undefined, () => {
    if (!enabled()) throw Object.assign(Error('积分赛换位已取消'), { notSent: true });
  });
  const info = await infoOf(client);
  if (!same(leagueFormationOrder(info, order.length, player).signature, expected)) throw Error('积分赛换位结果尚未确认');
  return info;
}

export async function recoverLeagueOrder(client, player, ledger, enabled = () => true) {
  if (!ledger || !uidText(player?.worldId) || !uidText(player?.playerId)) return;
  const key = recoveryKey(player);
  if (!ledger.hasKey(key)) return;
  const record = ledger.keyRecords()[key];
  const { original, temporary } = record.details;
  const info = await infoOf(client);
  if (uidText(info.mine?.playerId) !== uidText(player.playerId)) throw Error('积分赛角色已变化');
  if (!enabled()) throw Error('积分赛防守队序待恢复');
  // A later manual formation takes precedence. Only undo our exact temporary order.
  const current = leagueFormationOrder(info, info.ownFormations?.length, player).signature;
  if (same(current, temporary)) {
    await writeOrder(client, original.map(team => temporary.indexOf(team) + 1), original, player, enabled);
  }
  ledger.cancel(record);
}

export async function withLeagueOrder(client, player, ledger, original, order, enabled, fight) {
  const temporary = permute(original, order);
  if (same(original, temporary)) return fight();
  const before = leagueFormationOrder(await infoOf(client), order.length, player);
  if (!same(before.signature, original) || !enabled()) throw Error('积分赛阵容或设置已变化，已取消换位');
  const key = recoveryKey(player);
  ledger.reserve({}, {}, {}, { uniqueKey: key, details: { original, temporary } });
  try {
    await writeOrder(client, order, temporary, player, enabled);
    if (!enabled()) throw Error('积分赛设置已变化，已取消挑战');
    return await fight();
  } finally {
    await recoverLeagueOrder(client, player, ledger, () => client.connected !== false);
  }
}

export async function readManualLeagueOrder(client, config, player) {
  const required = config.tables.ModuleOpenCfg?.data?.find(row => row.moduleId === '跨服积分赛')?.playerLevel;
  if (!(player.level >= required)) throw Error('跨服积分赛尚未开放');
  const info = await infoOf(client);
  const count = config.tables.LeagueDanCfg?.data?.find(row => row.dan === info.roomDan)?.teamCount;
  const { teams, signature } = leagueFormationOrder(info, count, player);
  const names = new Map(config.tables.HeroCfg?.data?.map(hero => [hero.id, hero.name]));
  return { signature, teams: teams.map(team => team.heroPositions.map(pos => names.get(pos.heroId) || pos.heroId)) };
}

export async function moveLeagueTeam(client, config, player, ledger, payload, enabled) {
  await recoverLeagueOrder(client, player, ledger, enabled);
  const { teams, signature } = await readManualLeagueOrder(client, config, player);
  if (!same(signature, payload.signature)) throw Error('积分赛阵容已变化，请刷新后再换位');
  const { from, to } = payload;
  if (!Number.isInteger(from) || !Number.isInteger(to) || Math.min(from, to) < 1 ||
      Math.max(from, to) > teams.length || Math.abs(from - to) !== 1) throw Error('请选择相邻的两队');
  const order = [...orders[teams.length][0]];
  [order[from - 1], order[to - 1]] = [to, from];
  if (!enabled()) throw Error('账号连接已变化');
  const expected = permute(signature, order);
  await writeOrder(client, order, expected, player, enabled);
  return { signature: expected, teams: permute(teams, order) };
}
