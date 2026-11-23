import { exactAutomationId } from './automation-policy.mjs';
import { clock, dayOf, digest, moduleOpen, natural, positive, read, table, windowOpen } from './activity-actions.mjs';

export const portRevision = row => digest([row.specGoodsId || 0, row.rareGoodsId || 0, row.reportName || '']);

function intelWindow(config, event, player, time) {
  const first = table(config, 'ActivityTradeCfg').find(row => row.key === '海商王刷新时间');
  const hour = Number(String(first?.value).split(',')[0]);
  const offset = natural(hour) && hour < 24 ? hour * 3600 : 0;
  const cycle = dayOf(time - offset);
  const scope = digest([player?.worldId, player?.playerId, player?.guildId].map(exactAutomationId)
    .concat(event.startTime, event.period, cycle));
  return { scope, nextRefreshAt: (cycle + 1) * 86400 - 28800 + offset };
}

// 只合并游戏实际列出的港口；手动记录只提供货种信号，不提供价格或库存。
export function resolveMerchantIntel(config, event, player, radar, time, ledger) {
  const window = intelWindow(config, event, player, time);
  const edits = ledger?.merchantEdits?.(window.scope) ?? {};
  if (!Array.isArray(radar?.radar) || !Object.keys(edits).length) return { ...window, radar, edits };
  const valid = {};
  const rows = radar.radar.map(row => {
    const edit = edits[row?.cityId];
    if (!edit || edit.revision !== portRevision(row) || radar.radar.filter(port => port?.cityId === row.cityId).length !== 1) return row;
    valid[row.cityId] = edit;
    if (edit.specialtyId === (row.specGoodsId || 0) && edit.shortageId === (row.rareGoodsId || 0)) return row;
    return { ...row, specGoodsId: edit.specialtyId, rareGoodsId: edit.shortageId, manualIntel: true };
  });
  if (Object.keys(valid).length !== Object.keys(edits).length)
    ledger.saveMerchantEdits(window.scope, edits, valid, Math.min(window.nextRefreshAt, event.endTime), time);
  return { ...window, radar: { ...radar, radar: rows }, edits: valid };
}

export async function saveMerchantIntel(client, config, player, ledger, payload, enabled) {
  const event = { ...client.tradeWindow };
  const active = () => enabled() && windowOpen(event, clock(client)) && client.tradeWindow?.period === event.period &&
    client.tradeWindow.startTime === event.startTime && intelWindow(config, event, player, clock(client)).scope === payload.scope;
  const guildId = exactAutomationId(player?.guildId);
  if (!active() || !exactAutomationId(player?.worldId) || !exactAutomationId(player?.playerId) ||
    !guildId || BigInt(guildId) % 1000n === 0n || !moduleOpen(config, player, '海商王'))
    throw Error('本期活动或联盟已变化，请刷新总览');
  const radar = await read(client, 'TradeGuildRadar');
  if (!active() || !Array.isArray(radar?.radar)) throw Error('港口情报未同步，请刷新总览');
  const time = clock(client);
  const { scope, nextRefreshAt } = resolveMerchantIntel(config, event, player, radar, time, ledger);
  const previous = ledger.merchantEdits(scope), next = { ...previous };
  const goods = new Set(table(config, 'TradeGoodsCfg').map(row => row.goodsId));
  const changes = payload.changes;
  if (!Array.isArray(changes) || !changes.length || changes.length > radar.radar.length ||
    new Set(changes.map(change => change?.cityId)).size !== changes.length) throw Error('港口情报变更列表无效');
  for (const change of changes) {
    if (!positive(change?.cityId)) throw Error('港口编号无效');
    const ports = radar.radar.filter(row => row?.cityId === change.cityId);
    if (ports.length !== 1 || portRevision(ports[0]) !== change.revision ||
      (previous[change.cityId] ? digest(previous[change.cityId]) : null) !== change.editVersion)
      throw Error('该港游戏或手动情报已更新，请刷新后编辑');
    if (change.reset === true) { delete next[change.cityId]; continue; }
    const { specialtyId, shortageId, reporter } = change;
    if (![specialtyId, shortageId].every(id => id === 0 || goods.has(id)) ||
      !(reporter === null || typeof reporter === 'string' && reporter.length <= 80)) throw Error('商品或共享人无效');
    const name = reporter?.trim() || null, port = ports[0];
    if (specialtyId === (port.specGoodsId || 0) && shortageId === (port.rareGoodsId || 0) && name === (port.reportName?.trim() || null))
      delete next[change.cityId];
    else next[change.cityId] = { revision: change.revision, specialtyId, shortageId, reporter: name };
  }
  if (!ledger.saveMerchantEdits(scope, previous, next, Math.min(nextRefreshAt, event.endTime), time))
    throw Error('手动情报已更新，请刷新后编辑');
  return { scope, edits: merchantEditView(next) };
}

export function merchantEditView(edits) {
  return Object.fromEntries(Object.entries(edits).map(([id, edit]) => [id, { ...edit, version: digest(edit) }]));
}
