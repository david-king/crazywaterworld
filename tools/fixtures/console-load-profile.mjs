import fs from 'node:fs';
import path from 'node:path';
import { automationControlView } from '../../src/automation-controls.mjs';
import { migrateSettingsVersion, SettingsError, settingsFromLegacyNative, validateSettings } from '../../src/automation-settings.mjs';
import { getProtocol } from '../../src/proto.mjs';

// 只在 --local-max 压测中读取。账号标识用于匹配存档，从不复制登录数据到测试账号。
export function localLoadProfile(directory) {
  const json = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  const { accounts } = json('accounts.json');
  let best;
  const consider = (settings, account, source, revision, filled = []) => {
    const enabled = automationControlView(settings).filter(row => row.enabled && !row.blockedBy.length && !row.configurationNote).length;
    if (!enabled || best && (enabled < best.enabled || enabled === best.enabled && revision <= best.revision)) return;
    best = { settings, account, enabled, revision, source, filled };
  };
  const inspect = (file, source) => {
    let store;
    try { store = json(file); }
    catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') store = {};
      else throw error;
    }
    for (const account of accounts) {
      const entry = store.accounts?.[account.id];
      if (!entry) {
        if (source === 'current' && account.automation?.tasks)
          consider(settingsFromLegacyNative(account.automation.tasks, account.automation), account, source, 0);
        continue;
      }
      if (entry.recovery) continue;
      const version = entry.settingsVersion ?? 1;
      try {
        const migrated = migrateSettingsVersion(entry.settings, version, { source: 'stored' });
        const settings = validateSettings(migrated, { partial: version === 1 });
        const filled = ['allowDiamonds', 'diamondDailyLimit'].filter(key => !Object.hasOwn(entry.settings.guildShip ?? {}, key));
        consider(settings, account, source, entry.revision, filled.map(key => 'guildShip.' + key));
      } catch (error) { if (!(error instanceof SettingsError)) throw error; }
    }
  };
  inspect('automation-settings.json', 'current');
  if (!best) for (const file of fs.readdirSync(directory).filter(f => /^automation-settings\.json\.corrupt-.*\.bak$/.test(f))) {
    inspect(file, 'backup');
  }
  if (!best) throw Error('本地账号及其备份中没有可校验且已启用的挂机配置');
  const { account, ...profile } = best;
  const keys = fs.existsSync(path.join(directory, 'automation-usage.json')) ? json('automation-usage.json').accounts?.[account.id]?.keys ?? {} : {};
  // 仅保留记录数与序列化字节数，压测账号不继承真实订单、消费和未决操作。
  const history = { count: Object.keys(keys).length, bytes: Buffer.byteLength(JSON.stringify(keys)) };
  const prefix = account.id.slice(0, 8);
  const responses = new Map();
  // 只复用无需参数的状态查询。排除登录、玩家资料、聊天及操作结果。
  const readOnly = new Set(['OnWater', 'AllItem', 'MyFleets', 'AllResource', 'MonthCard', 'WeekInfo',
    'WeekChargeInfo', 'WeekOrderInfo', 'WeekLotteryInfo', 'RecruitInfo', 'FishEncyclopedia', 'MuseumInfo',
    'ClickGoldInfo', 'AllPet', 'GuildShip', 'PirateKillRecord', 'WarDeclaration', 'UniteWorldsPlan',
    'SeasonTaskStage', 'AllPirate', 'ChipMineList', 'ChipMineReward', 'TreasureLootStats', 'TreasureLootList',
    'DailyTaskInfo', 'AfkInfo', 'WorldBossInfo', 'GuildOrder', 'FirstCharge', 'TrialRaidInfo', 'WeekChipInfo']);
  if (accounts.filter(row => row.id.startsWith(prefix)).length === 1) {
    const logs = ['protocol.log', 'protocol.log.1'].map(f => path.join(directory, f)).filter(f => fs.existsSync(f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    for (const file of logs) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\S+ \[([^\]]+)\] \[(\w+)Response\] seq=\d+ (\{.*\})\s*$/.exec(line);
      if (match?.[1] !== prefix || !readOnly.has(match[2])) continue;
      try { responses.set(match[2] + 'Request', JSON.parse(match[3])); } catch { /* 忽略不完整记录 */ }
    }
  }
  return { ...profile, history, responses, level: account.lastSeen?.level || 1, worldId: account.lastSeen?.worldId || 9001 };
}

// 使用真实协议编解码、请求队列、读闸、日志与推送监听，只替换传输对端。
export function installReplay(GameClient, profile, online) {
  const protocol = getProtocol();
  const calls = new Map(), replayed = new Map(), unavailable = new Map();
  GameClient.prototype.connect = async function (login) {
    if (!/^bench-\d+$/.test(login?.eworldParams?.openId)) throw Error('非压测账号');
    const index = Number(login.eworldParams.openId.slice(6));
    this.socket = { readyState: 1, send() {}, close() { this.readyState = 3; } };
    online.add(this);
    const fleets = structuredClone(profile.responses.get('MyFleetsRequest'));
    const guildId = fleets?.fleets?.[0]?.owner?.guildId;
    for (const fleet of fleets?.fleets ?? []) if (fleet.owner) {
      fleet.owner.playerId = index;
      fleet.owner.nickname = '压测角色 ' + index;
    }
    let sequence = 0;
    this.on('frame', ({ dir, name, body }) => {
      if (dir !== 'out' || !name.endsWith('Request')) return;
      calls.set(name, (calls.get(name) ?? 0) + 1);
      const pending = this.pending.at(-1);
      if (pending?.name !== name || pending.order !== this.sendOrder - 1) return;
      const reply = [pending.responseName].flat().find(key => protocol[key]);
      if (!reply) throw Error('压测协议中缺少响应类型：' + name);
      const recorded = !Object.keys(body ?? {}).length && reply === name.replace(/Request$/, 'Response')
        && (name === 'MyFleetsRequest' ? fleets : profile.responses.get(name));
      const value = recorded || (name === 'AllResourceRequest' ? { list: [{ res: 3, amount: 1000 }] } : {});
      setTimeout(() => {
        if (!this.connected) return;
        let frame;
        try { frame = this.codec.encode(reply, sequence + 1, new protocol[reply](value)); }
        catch {
          unavailable.set(name, (unavailable.get(name) ?? 0) + 1);
          const slot = this.pending.indexOf(pending);
          if (slot >= 0) {
            this.pending.splice(slot, 1);
            clearTimeout(pending.timer);
            pending.reject(Error('离线回包缺少必填数据：' + reply));
          }
          return;
        }
        sequence++;
        if (recorded) replayed.set(name, (replayed.get(name) ?? 0) + 1);
        this.onMessage(frame);
      }, 5);
    });
    this.setState('READY');
    const reply = { result: 0, playerInfo: { playerId: index, guildId, worldId: profile.worldId, scenarioId: 1,
      level: profile.level, nickname: '压测角色 ' + index } };
    this.emit('login', reply);
    return reply;
  };
  return { protocol, calls, replayed, unavailable };
}
