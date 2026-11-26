import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { accountKey, dataDirectory } from './usage-ledger.mjs';
import { validPlayerIdText } from './extended-settings.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { playerPowerText } from './opponent-power.mjs';
import { publicChatChannel } from './chat-protocol.mjs';

const historyFile = account => path.join(dataDirectory(), 'player-names', createHash('sha256').update(accountKey(account)).digest('hex') + '.json');

export async function readWorldListPlayers(client, player, check, rankType, previous) {
  const ownId = exactAutomationId(player.playerId);
  const members = new Map(previous?.members.map(row => [row.id, row]));
  const unavailable = [];
  if (!ownId) throw Error('当前角色身份未同步');
  function add(source, rows, powerKey = 'power') {
    for (const row of rows) {
      const id = exactAutomationId(row?.playerId), name = row?.nickname;
      if (!id || id === ownId || typeof name !== 'string' || !name.trim() || name.length > 120) continue;
      const power = playerPowerText(row, powerKey), known = members.get(id);
      if (known) {
        if (known.power == null && power != null) members.set(id, { ...known, power });
      } else {
        members.set(id, { id, name, source, power, guildIdx: row.guildIdx > 0 ? row.guildIdx : null });
      }
    }
  }
  async function read(source, request, args, rows) {
    check();
    try {
      const reply = await client.request(request, args, request.replace(/Request$/, 'Response'), 8000, check);
      add(source, rows(reply));
    } catch { unavailable.push(source); }
    check();
  }
  const page = (previous?.rankPage ?? 0) + 1;
  let rankPages = 0;
  check();
  try {
    if (!Number.isInteger(rankType)) throw Error('当前版本缺少战力榜');
    const rank = await client.request('RankRequest', { rankType, page }, 'RankResponse', 8000, check);
    if (!Array.isArray(rank?.rankData)) throw Error('服务器未返回战力榜名单');
    add('战力榜', rank.rankData, 'rankValue');
    if (Number.isInteger(rank.maxPage) && rank.maxPage > 0) rankPages = rank.maxPage;
    else if (rank.rankData.length) rankPages = page;
  } catch {
    check();
    if (previous) throw Error('战力榜第 ' + page + ' 页未同步，请重试');
    unavailable.push('战力榜');
  }
  check();
  if (!previous) {
    await read('世界舰队', 'WorldInfoRequest', { screenCenter: { x: 0, y: 0 } }, reply => reply.fleets.map(fleet => fleet.owner));
    await read('黑名单', 'BlackListRequest', {}, reply => reply.list);
    await read('世界聊天', 'ChatRecordRequest', { channel: publicChatChannel(client.protocol, 1) }, reply => reply.message
      .filter(message => message.content && !message.content.systemMsgId)
      .sort((a, b) => b.timestamp - a.timestamp).map(message => message.sender));
    await read('私聊联系人', 'PrivateChatListRequest', {}, reply => reply.chats.map(chat => chat.peer));
  }
  return {
    members: [...members.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)),
    rankPage: Math.min(page, rankPages), rankPages,
    reason: previous?.reason ?? (unavailable.length ? unavailable.join('、') + '未同步，可稍后刷新' : ''),
  };
}

function listRules(settings) {
  const treasure = settings?.treasure ?? {}, alliance = settings?.alliance ?? {}, fleets = settings?.silicon?.fleets ?? [];
  const ids = new Set([...(treasure.followPlayerIds ?? []), ...(treasure.avoidPlayerIds ?? []), ...(treasure.chasePlayerIds ?? []),
    ...(alliance.memberIds ?? []), ...fleets.flatMap(f => [...(f.safePlayerIds ?? []), ...(f.huntPlayerIds ?? [])])]);
  const names = new Set([...(treasure.followNames ?? []), ...(treasure.avoidNames ?? []), ...(treasure.chaseNames ?? [])]);
  const folded = new Set([...(alliance.memberKeywords ?? []), ...fleets.flatMap(f => [...(f.huntPlayers ?? []), ...(f.safePlayers ?? [])])].map(name => name.toLocaleLowerCase()));
  return { ids, hasNames: names.size > 0 || folded.size > 0, matches: name => names.has(name) || folded.has(name.toLocaleLowerCase()) };
}

function listed(rules, id, record) {
  return rules.ids.has(id) || record && (rules.matches(record.name) || record.previous.some(rules.matches));
}

export function listedPlayerNames(account, settings) {
  const rules = listRules(settings);
  if (!rules.ids.size && !rules.hasNames) return {};
  const history = readJson(historyFile(account), {});
  return Object.fromEntries(Object.entries(history).filter(([id, record]) => listed(rules, id, record)));
}

// 仅同一个精确 ID 的新资料可以更新昵称。行军等快照只用于建立首次对应关系。
export function rememberPlayerNames(account, settings, observations, { initialOnly = false } = {}) {
  const rules = listRules(settings);
  if (!rules.ids.size && !rules.hasNames) return;
  const profiles = new Map();
  for (const row of observations) {
    const { id, name } = row;
    if (!validPlayerIdText(id) || typeof name !== 'string' || !name.trim() || name.length > 120) continue;
    if (initialOnly && !rules.ids.has(id) && !rules.matches(name)) continue;
    const prior = profiles.get(id);
    profiles.set(id, profiles.has(id) && prior?.name !== name ? null : { name, power: playerPowerText(row) ?? prior?.power });
  }
  if (!profiles.size) return;
  const file = historyFile(account);
  function changes(history) {
    const updates = [];
    for (const [id, profile] of profiles) {
      const old = history[id];
      if (!profile || !(rules.matches(profile.name) || listed(rules, id, old))) continue;
      if (initialOnly && old && (old.name !== profile.name || old.power != null)) continue;
      const { name } = profile, power = profile.power ?? old?.power;
      if (name === old?.name && power === old.power) continue;
      const previous = old && old.name !== name ? [...new Set([old.name, ...old.previous])].filter(alias => alias !== name) : old?.previous ?? [];
      updates.push([id, { name, previous, ...(power == null ? {} : { power }) }]);
    }
    return updates;
  }
  if (!changes(readJson(file, {})).length) return;
  return withFileLock(file, () => {
    const history = readJson(file, {}), updates = changes(history);
    if (!updates.length) return;
    const changed = Object.fromEntries(updates);
    atomicJson(file, { ...history, ...changed });
    return changed;
  });
}

export function knownListPlayerIds(settings, history) {
  return new Set([...listRules(settings).ids, ...Object.keys(history)]);
}

export function prunePlayerNames(account, settings) {
  const file = historyFile(account), rules = listRules(settings);
  if (!fs.existsSync(file)) return;
  withFileLock(file, () => {
    if (!settings) { fs.rmSync(file, { force: true }); return; }
    const history = readJson(file, {});
    const keep = Object.entries(history).filter(([id, record]) => listed(rules, id, record));
    if (!keep.length) fs.rmSync(file, { force: true });
    else if (keep.length !== Object.keys(history).length) atomicJson(file, Object.fromEntries(keep));
  });
}
