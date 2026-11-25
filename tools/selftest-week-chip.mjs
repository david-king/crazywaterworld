import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import { weekChipPlan, weekChipStatistics, updateChipFactoryScore } from '../src/week-chip.mjs';
import { runWeekChip } from '../src/activities.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { loadProtocol } from '../src/proto.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-week-chip-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
process.env.CW_DATA_DIR = dir;
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const tables = {
  BuildingUnlockCfg: { data: [{ buildingId: '1芯片厂', buildingType: '芯片厂', playerLevel: 51 }] },
  WeekChipPointsCfg: { data: [{ rwdId: 1, amount: 1000 }, { rwdId: 6, amount: 8000 }] },
  WeekChipPeriodCfg: { data: [{ periodId: 3001, round: 5 }] },
  WeekChipPackCfg: { data: [{ packId: 1, price: 0, buyLimit: 1, giftName: '免费礼包' }] },
};
process.env.CW_CONFIG_PACK = path.join(dir, 'config.json');
const config = { tables }, protocol = loadProtocol(), now = Math.floor(Date.now() / 1000);
const event = { type: 6, period: 3001, startTime: now - 3600, endTime: now + 7200 };
const activityId = 'weekly:6:3001:' + event.startTime;
const values = { 白芯片宝箱: 1, 绿芯片宝箱: 10, 蓝芯片宝箱: 20, 紫芯片宝箱: 50 };
const rebateConfig = { tables: { ...tables,
  WeekChipPointsCfg: { data: [1000, 2000, 3000, 4000, 6000, 8000].map((amount, i) => ({
    amount, rwdId: i + 1, reward: i === 5 ? [['芯片货币', 1000]] : [['绿芯片宝箱', 10]],
  })) },
  WeekChipPackCfg: { data: [{ packId: 1000, price: 0, buyLimit: 1, reward: [['白芯片宝箱', 10]] }] },
  ChestScoreCfg: { data: [{ level: 1, score: 10, reward: ['白芯片宝箱', 1] }, { level: 2, score: 20, reward: ['绿芯片宝箱', 1] }] },
} };
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(rebateConfig.tables).map(([name, table], i) => [i, name, table])));
function fixture(owner, score, stock, round = 1, cfg = config) {
  const f = { owner, stock: new Map(Object.entries(stock)), score, round, event: { ...event }, writes: [],
    rewards: [], gotTaskId: [], gifts: [], player: { chipStage: 1, chipScore: 0 }, buildings: [{ buildingId: '1芯片厂', level: 1 }], enabled: true };
  const pack = cfg.tables.WeekChipPackCfg.data.find(row => row.price === 0);
  const credit = reward => {
    for (const [id, count] of reward ?? []) f.stock.set(id, (f.stock.get(id) ?? 0) + count);
  };
  const client = Object.assign(new EventEmitter(), { connected: true, festivals: [], stop() { this.connected = false; } });
  f.client = client;
  client.request = async (name, body, response, timeout, beforeSend) => {
    beforeSend?.();
    const request = protocol[name].decode(protocol[name].encode(body).finish());
    let data;
    switch (name) {
      case 'WeekInfoRequest': data = { activityTime: [f.event] }; break;
      case 'WeekChipInfoRequest': data = { score: f.score, round: f.round, gifts: f.gifts, gotTaskId: f.gotTaskId }; break;
      case 'AllItemRequest': data = { items: [...f.stock].map(([itemId, num]) => ({ itemId, num })) }; break;
      case 'OnWaterRequest':
        if (f.waterError) throw Error('海面读取超时');
        data = { building: f.buildings };
        break;
      case 'ChipChestOpenRequest': {
        const { itemId, num } = request.item, count = Number(num);
        assert(values[itemId] && count > 0 && count <= 500 && count <= f.stock.get(itemId));
        f.writes.push([itemId, count]);
        if (f.beforeWrite) await f.beforeWrite();
        f.stock.set(itemId, f.stock.get(itemId) - count);
        f.score += values[itemId] * count;
        if (f.afterWrite) await f.afterWrite();
        data = { addScore: count * values[itemId] };
        updateChipFactoryScore(f.player, response, data);
        break;
      }
      case 'WeekChipGotTaskRequest': {
        const tiers = cfg.tables.WeekChipPointsCfg.data;
        const tier = tiers.find(t => t.rwdId === request.taskId);
        assert.equal(request.round, f.round);
        assert(tier.amount <= f.score - 8000 * (f.round - 1) && !f.gotTaskId.includes(tier.rwdId));
        f.rewards.push([name, f.round, tier.rwdId]);
        f.beforeReward?.();
        f.gotTaskId.push(tier.rwdId);
        credit(tier.reward);
        if (f.gotTaskId.length === tiers.length) { f.round++; f.gotTaskId = []; }
        data = { round: f.round, gotTaskId: f.gotTaskId, reward: {} };
        f.afterReward?.();
        break;
      }
      case 'WeekChipGotFreeRequest': {
        assert(pack && !f.gifts.length);
        f.gifts.push({ giftId: pack.packId, paidTimes: 1 });
        credit(pack.reward);
        f.rewards.push([name, f.round, pack.packId]);
        data = { reward: {} };
        break;
      }
      case 'ChipChestGotScoreRequest': {
        const tier = cfg.tables.ChestScoreCfg.data.find(t => t.level === f.player.chipStage);
        assert(f.player.chipScore >= tier.score);
        credit([tier.reward]);
        f.rewards.push([name, f.round, tier.level]);
        data = { stage: f.nextFactoryStage?.(tier) ?? tier.level + 1, score: f.player.chipScore - tier.score, reward: {} };
        updateChipFactoryScore(f.player, response, data);
        f.afterFactory?.(tier);
        break;
      }
      default: throw Error('未模拟请求 ' + name);
    }
    return protocol[response].decode(protocol[response].encode(data).finish());
  };
  f.plan = () => weekChipPlan(cfg, f.event, activityId, owner, f, f.stock, f.player, { pack, done: f.gifts.length > 0 });
  f.run = (planKey, options = {}) => runWeekChip(client, cfg, { activityId, planKey, owner, player: f.player,
    ledger: createUsageLedger(owner), enabled: () => f.enabled, ...options });
  return f;
}

test('五类库存和预计积分区分已领、可达与不可达返晶，轮次按结算计数', () => {
  const cfg = { tables: { ...tables, WeekChipPointsCfg: { data: [1000,2000,3000,4000,6000,8000].map((amount,i) =>
    ({ amount, rwdId: i + 1, reward: i === 5 ? [['芯片货币',1000]] : [['绿芯片宝箱',10]] })) },
    ChestScoreCfg: { data: [{ level: 4, score: 80, reward: ['蓝芯片宝箱',1] }] } } };
  const freePack = { done: true, pack: { reward: [['白芯片宝箱',10]] } };
  const project = (inventory, info, player = null, gift = freePack) => {
    const stock = new Map(Object.entries(inventory));
    const plan = weekChipPlan(cfg, event, activityId, 'test', info, stock);
    return weekChipStatistics(cfg, plan, info, stock, player, gift);
  };
  const fresh = { round: 1, score: 0, gotTaskId: [], gifts: [] };
  const stats = project({ 白芯片宝箱: 1934, 绿芯片宝箱: 304, 蓝芯片宝箱: 81, 紫芯片宝箱: 20 }, fresh);
  assert.deepEqual(stats.inventory.map(row => row.count), [1934,304,81,20,0]);
  assert.deepEqual([stats.completed,stats.cap,stats.forecast,stats.weekly,stats.factory], [0,8000,8000,500,null]);
  const atEdge = project({ 白芯片宝箱: 970, 橙芯片宝箱: 100 }, fresh, { chipStage: 4, chipScore: 0 }, { ...freePack, done: false });
  assert.deepEqual([atEdge.gift,atEdge.factory,atEdge.weekly,atEdge.forecast], [10,20,100,1100]);
  assert.equal(project({ 白芯片宝箱: 969 }, fresh, { chipStage: 4, chipScore: 0 }, { ...freePack, done: false }).forecast,999);
  assert.equal(project({ 橙芯片宝箱: 30 }, { ...fresh, score: 1000, gotTaskId: [1] }).forecast,1000);
  const overflowing = project({ 白芯片宝箱: 1700 }, { ...fresh, score: 7900 });
  assert.deepEqual([overflowing.completed,overflowing.weekly,overflowing.forecast], [0,500,8000]);
  const second = project({ 白芯片宝箱: 750 }, { ...fresh, round: 2, score: 8300 });
  assert.deepEqual([second.completed,second.weekly,second.forecast], [1,100,1150]);
  const almostDone = project({ 白芯片宝箱: 200 }, { ...fresh, round: 2, score: 15995 }, { chipStage: 4, chipScore: 70 });
  assert.deepEqual([almostDone.factory,almostDone.forecast], [0,8000]);
  const awaiting = project({}, { ...fresh, round: 5, score: 40000, gotTaskId: [1,2,3,4,5] });
  assert.deepEqual([awaiting.completed,awaiting.qualified,awaiting.forecast], [4,5,8000]);
  for (const round of [5,6]) {
    const final = project({ 白芯片宝箱: 9999 }, { ...fresh, round, score: 40000, gotTaskId: [1,2,3,4,5,6] });
    assert.deepEqual([final.completed,final.forecast], [5,8000]);
  }
  const player = { chipScore: 9, chipStage: 2 };
  updateChipFactoryScore(player,'ChipChestOpenResponse',{ addScore: 20 });
  assert.equal(player.chipScore,29);
  updateChipFactoryScore(player,'ChipChestGotScoreResponse',{ score: 9, stage: 3 });
  assert.deepEqual(player,{ chipScore: 9, chipStage: 3 });
});

test('按本轮积分精确配晶，不能整凑时选择最少溢分，库存不足和特级硅晶不消费', async () => {
  const f = fixture('plan', 15940, { 紫芯片宝箱: 1, 蓝芯片宝箱: 3, 橙芯片宝箱: 999 }, 2);
  const p = f.plan();
  assert.deepEqual([p.score, p.gap, p.available, p.gain], [7940, 60, 110, 60]);
  assert.deepEqual(p.items.map(i => [i.id, i.count]), [['蓝芯片宝箱', 3]]);
  f.score = 15939;
  assert.equal(f.plan().gain, 70);
  f.score = 15000;
  assert.equal(f.plan().key, null);
  await assert.rejects(f.run(p.key), /已变化/);
  assert.equal(f.writes.length, 0);
});

test('7594 分库存靠本轮五档返晶精确达到 8000 分，领完第六档即停', async () => {
  const f = fixture('rebates', 0, { 白芯片宝箱: 1934, 绿芯片宝箱: 304, 蓝芯片宝箱: 81, 紫芯片宝箱: 20, 橙芯片宝箱: 5 }, 1, rebateConfig);
  f.gifts = [{ giftId: 1000, paidTimes: 1 }];
  Object.assign(f.player, { chipStage: 1, chipScore: 0 });
  const plan = f.plan();
  assert.deepEqual([plan.available, plan.statistics.weekly, plan.statistics.gift, plan.statistics.factory, plan.statistics.forecast, plan.gain],
    [7594, 500, 0, 1, 8000, 8000]);
  assert(plan.key);
  await f.run(plan.key);
  assert.equal(f.round, 2);
  assert.equal(f.score, 8000);
  assert.deepEqual(f.rewards, [...[1,2,3,4,5].map(id => ['WeekChipGotTaskRequest',1,id]),
    ['ChipChestGotScoreRequest',1,1], ['ChipChestGotScoreRequest',1,2], ['WeekChipGotTaskRequest',1,6]]);
  assert.equal(f.stock.get('橙芯片宝箱'), 5);
  assert.equal(f.plan().available, 105);
  assert.equal(f.plan().key, null);
  await assert.rejects(f.run(plan.key), /已变化/);
});

test('仅靠礼包和已知芯片厂档位补足时可执行，差一分或已领过则不开晶', async () => {
  const f = fixture('other-rebates', 8000, { 白芯片宝箱: 7489 }, 2, rebateConfig);
  Object.assign(f.player, { chipStage: 1, chipScore: 0 });
  const plan = f.plan();
  assert.equal(plan.statistics.forecast, 8000);
  assert.equal(plan.gain, 8000);
  assert.equal(plan.actions.filter(a => a.kind === 'factory').length, 1);
  f.stock.set('白芯片宝箱', 7488);
  assert.deepEqual([f.plan().key, f.plan().statistics.forecast], [null, 7999]);
  await assert.rejects(f.run(plan.key), /已变化/);
  f.stock.set('白芯片宝箱', 7489);
  f.gifts.push({ giftId: 1000, paidTimes: 1 });
  assert.equal(f.plan().key, null);
  assert.equal(f.writes.length, 0);
  f.gifts = [];
  await f.run(plan.key);
  assert.deepEqual([f.round, f.score], [3, 16000]);
  assert.deepEqual(f.rewards.filter(([name]) => name !== 'WeekChipGotTaskRequest'),
    [['ChipChestGotScoreRequest', 2, 1], ['WeekChipGotFreeRequest', 2, 1000], ['ChipChestGotScoreRequest', 2, 2]]);
});

test('已达标可补领奖，领奖超时后先核对，到账前不加工也不重领', async () => {
  const f = fixture('claim-only', 40000, {}, 5, rebateConfig);
  f.buildings = [];
  f.waterError = true;
  f.gotTaskId = [1,2,3,4,5];
  const claim = f.plan();
  assert.equal(claim.gain, 0);
  assert.deepEqual(claim.actions.map(a => [a.kind, a.id]), [['gift',1000], ['weekly',6]]);
  await f.run(claim.key);
  assert.deepEqual([f.round, f.plan().key, f.writes.length], [6, null, 0]);

  const g = fixture('reward-timeout', 7900, {}, 1, rebateConfig);
  g.gotTaskId = [1,2,3,4];
  const key = g.plan().key;
  g.beforeReward = () => { throw Error('超时'); };
  await assert.rejects(g.run(key), /结果待确认/);
  await assert.rejects(g.run(key), /尚未核实/);
  g.gotTaskId.push(5);
  await assert.rejects(g.run(key), /尚未核实/);
  assert.deepEqual([g.writes.length, g.rewards.length], [0,1]);
  g.stock.set('绿芯片宝箱', 10);
  g.beforeReward = null;
  await g.run(g.plan().key);
  assert.deepEqual(g.writes, [['绿芯片宝箱',10]]);
  assert.deepEqual(g.rewards, [['WeekChipGotTaskRequest',1,5], ['ChipChestGotScoreRequest',1,1], ['ChipChestGotScoreRequest',1,2],
    ['WeekChipGotFreeRequest',1,1000], ['WeekChipGotTaskRequest',1,6]]);
});

test('达标收尾领取免费礼包和连续工厂奖励，按回包跨档循环，返晶留在背包', async () => {
  const items = ['白芯片宝箱', '绿芯片宝箱', '绿芯片宝箱', '蓝芯片宝箱', '蓝芯片宝箱', '紫芯片宝箱', '橙芯片宝箱'];
  const cfg = { tables: { ...rebateConfig.tables,
    ChestScoreCfg: { data: [10,20,50,80,100,150,200].map((score, i) => ({ level: i + 1, score, reward: [items[i],1] })) },
    WeekChipPackCfg: { data: [{ packId: 1001, price: 30, reward: [['紫芯片宝箱',4]] }, ...rebateConfig.tables.WeekChipPackCfg.data] },
  } };
  const f = fixture('closing-cycle', 39999, { 白芯片宝箱: 1 }, 5, cfg);
  f.gotTaskId = [1,2,3,4,5];
  Object.assign(f.player, { chipStage: 7, chipScore: 819 });
  f.nextFactoryStage = tier => tier.level === 7 ? 1 : tier.level + 1;
  const result = await f.run(f.plan().key);
  assert.deepEqual(f.rewards, [...[7,1,2,3,4,5,6,7,1].map(stage => ['ChipChestGotScoreRequest',5,stage]),
    ['WeekChipGotFreeRequest',5,1000], ['WeekChipGotTaskRequest',5,6]]);
  assert.deepEqual(result.claimed, { weekly: 1, gift: 1, factory: 9 });
  assert.deepEqual([f.round, f.score, f.player.chipStage, f.player.chipScore], [6,40000,2,0]);
  assert.deepEqual(f.writes, [['白芯片宝箱',1]]);
  assert.deepEqual([f.stock.get('白芯片宝箱'), f.stock.get('橙芯片宝箱')], [12,2]);
  assert.equal(f.plan().key, null);
});

test('工厂奖励未到账时保留本轮最后一档，核实后只补领剩余奖励', async () => {
  const cfg = { tables: { ...rebateConfig.tables, ChestScoreCfg: { data: [{ level: 7, score: 200, reward: ['橙芯片宝箱',1] }] } } };
  const f = fixture('closing-delayed', 7999, { 白芯片宝箱: 1 }, 1, cfg);
  f.gotTaskId = [1,2,3,4,5];
  Object.assign(f.player, { chipStage: 7, chipScore: 199 });
  f.afterFactory = () => { f.stock.set('橙芯片宝箱', 0); };
  await assert.rejects(f.run(f.plan().key), /等待积分、领奖状态和硅晶库存同步/);
  assert.deepEqual([f.round, f.score], [1,8000]);
  await assert.rejects(f.run(f.plan().key), /尚未核实/);
  f.stock.set('橙芯片宝箱', 1);
  const resumed = await f.run(f.plan().key);
  assert.deepEqual(resumed.claimed, { weekly: 1, gift: 1, factory: 0 });
  assert.deepEqual(f.rewards, [['ChipChestGotScoreRequest',1,7], ['WeekChipGotFreeRequest',1,1000], ['WeekChipGotTaskRequest',1,6]]);
  assert.deepEqual(f.writes, [['白芯片宝箱',1]]);
  assert.equal(f.round, 2);
});

test('礼包在加工期间刷新或已领，收尾以最新活动回包为准', async () => {
  for (const resets of [true, false]) {
    const f = fixture('gift-refresh-' + resets, 7999, { 白芯片宝箱: 1 }, 1, rebateConfig);
    const taken = [{ giftId: 1000, paidTimes: 1 }];
    f.gifts = resets ? taken : [];
    f.afterWrite = () => { f.gifts = resets ? [] : taken; };
    const result = await f.run(f.plan().key);
    assert.equal(result.claimed.gift, resets ? 1 : 0);
    assert.equal(result.claimed.weekly, 6);
    assert.equal(f.round, 2);
  }
});

test('已建厂但工厂余额未同步时保留最后的周奖励，恢复后只领奖', async () => {
  const f = fixture('closing-unknown', 7999, { 白芯片宝箱: 1 }, 1, rebateConfig);
  f.gotTaskId = [1,2,3,4,5];
  f.player.chipScore = null;
  await assert.rejects(f.run(f.plan().key), /芯片厂档位或积分尚未同步/);
  assert.deepEqual([f.round, f.score, f.rewards.length], [1,8000,0]);
  await assert.rejects(f.run(f.plan().key), /芯片厂档位或积分尚未同步/);
  f.player.chipScore = 10;
  const resumed = await f.run(f.plan().key);
  assert.deepEqual(resumed.claimed, { weekly: 1, gift: 1, factory: 1 });
  assert.deepEqual(f.writes, [['白芯片宝箱',1]]);
  assert.equal(f.round, 2);
});

test('开晶前核实海面建筑，未建成或读取失败时连开晶方案里的领奖也不发送', async () => {
  const f = fixture('factory-gate', 7900, {}, 1, rebateConfig);
  f.gotTaskId = [1,2,3,4];
  const plan = f.plan();
  assert.equal(plan.actions[0].kind, 'weekly');
  Object.assign(f.player, { level: 28, chipStage: 1, chipScore: 500 });
  f.buildings = [{ buildingId: '1硅矿厂', level: 1 }];
  await assert.rejects(f.run(plan.key), /当前角色 28 级，51 级可建造芯片厂/);
  f.player.level = 51;
  await assert.rejects(f.run(plan.key), /请先在海面建成芯片厂/);
  f.buildings.push({ buildingId: '1芯片厂', level: 0, buildStartTime: now, buildFinishTime: now + 5100 });
  await assert.rejects(f.run(plan.key), /芯片厂正在建造/);
  f.waterError = true;
  await assert.rejects(f.run(plan.key), /芯片厂建筑状态读取失败/);
  assert.deepEqual([f.writes.length, f.rewards.length], [0, 0]);
  assert.deepEqual(createUsageLedger(f.owner).keyRecords(), {});
  f.waterError = false;
  f.buildings = [{ buildingId: '1芯片厂', level: 1 }];
  await f.run(plan.key);
  assert.equal(f.round, 2);
});

test('游戏仍拒绝开晶时解释 no building，并释放该次明确拒绝的记录', async () => {
  const f = fixture('factory-rejected', 7999, { 白芯片宝箱: 1 });
  f.beforeWrite = () => { throw Object.assign(Error('server prompt: no building'),
    { prompt: { args: ['no building'] }, request: 'ChipChestOpenRequest' }); };
  await assert.rejects(f.run(f.plan().key), /游戏未检测到已建成的芯片厂/);
  assert.deepEqual(createUsageLedger(f.owner).keyRecords(), {});
  assert.deepEqual([f.score, f.rewards.length], [7999, 0]);
});

test('跨批执行只到指定轮次，拒绝过期预览、串号、过期活动和已完成的重复点击', async () => {
  const f = fixture('batches', 15499, { 白芯片宝箱: 600 }, 2), key = f.plan().key;
  await assert.rejects(f.run(key, { owner: 'other' }), /已变化/);
  f.event.endTime = now - 1;
  await assert.rejects(f.run(key), /未开放/);
  f.event.endTime = event.endTime;
  f.score++;
  await assert.rejects(f.run(key), /已变化/);
  f.score--;
  assert.equal(f.writes.length, 0);
  const result = await f.run(key);
  assert.match(result.message, /第 2 轮/);
  assert.deepEqual(f.writes, [['白芯片宝箱', 500], ['白芯片宝箱', 1]]);
  assert.equal(f.score, 16000);
  assert.equal(f.round, 3);
  await assert.rejects(f.run(key), /已变化/);
  assert.equal(f.writes.length, 2);
});

test('不确定的发送跨重试防重，得到库存和得分证据后只补剩余批次', async () => {
  const f = fixture('lost', 7499, { 白芯片宝箱: 600 });
  f.beforeWrite = () => { throw Error('超时'); };
  const key = f.plan().key;
  await assert.rejects(f.run(key), /结果待确认/);
  await assert.rejects(f.run(key), /尚未核实/);
  assert.equal(f.writes.length, 1);
  f.beforeWrite = null;
  f.stock.set('白芯片宝箱', 100);
  f.score += 500;
  await f.run(f.plan().key);
  assert.deepEqual(f.writes, [['白芯片宝箱', 500], ['白芯片宝箱', 1]]);
});

test('明确拒绝允许重新确认，暂停与回读异常均停止剩余批次', async () => {
  const f = fixture('reject', 7499, { 白芯片宝箱: 600 }), key = f.plan().key;
  f.beforeWrite = () => { throw Object.assign(Error('拒绝'), { prompt: true, request: 'ChipChestOpenRequest' }); };
  await assert.rejects(f.run(key), /拒绝/);
  assert.equal(createUsageLedger(f.owner).snapshot().uncertain, 0);
  f.beforeWrite = null;
  f.afterWrite = () => { f.enabled = false; };
  await assert.rejects(f.run(key), /连接已变化/);
  assert.equal(f.score, 7999);
  const g = fixture('delayed', 7499, { 白芯片宝箱: 600 });
  g.afterWrite = () => { g.score -= 500; };
  await assert.rejects(g.run(g.plan().key), /等待积分/);
  assert.equal(g.writes.length, 1);
  await assert.rejects(g.run(g.plan().key));
  assert.equal(g.writes.length, 1);
});

test('活动页 HTTP 预览只读，确认请求绑定账号，并发双击只执行一次', async () => {
  const { createConsole } = await import('../src/server.mjs');
  const { saveStore } = await import('../src/accounts.mjs');
  const accounts = ['chip-http-a', 'chip-http-b', 'chip-http-rebates'];
  saveStore({ activeId: accounts[0], accounts: accounts.map(id => ({ id, label: id,
    url: 'wss://fixture.invalid', login: {}, automation: { enabled: false, autoStart: false } })) });
  const app = createConsole({ port: 0, protocol });
  try {
    const base = await app.listen();
    const respond = async (id, body) => {
      const url = new URL(body ? '/api/activities/week-chip/open' : '/api/activities', base);
      url.searchParams.set('account', id);
      const response = await fetch(url, body && { method: 'POST', headers: { 'content-type': 'application/json',
        'x-cw-console-version': version }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const version = (await fetch(base)).headers.get('x-cw-console-version');
    const fixtures = [];
    for (const id of accounts) {
      await fetch(base + '/api/settings?account=' + id);
      const f = id === accounts[2] ? fixture(id, 0, { 白芯片宝箱: 7489 }, 1, rebateConfig)
        : fixture(id, 7999, { 绿芯片宝箱: 2 }, 1, rebateConfig);
      Object.assign(f.player, { level: 60, playerId: '1234', chipStage: 1, chipScore: 0 });
      Object.assign(app.sessions.get(id), { paused: false, player: f.player, client: f.client });
      fixtures.push(f);
    }
    const view = await respond(accounts[0]);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const preview = view.body.status[activityId].chip;
    assert.equal(preview.gain, 10);
    assert.deepEqual(preview.statistics.inventory.map(row => row.count), [0,2,0,0,0]);
    assert.deepEqual([preview.statistics.forecast, preview.statistics.completed, preview.roundLimit], [8000,0,5]);
    const body = { activityId, planKey: preview.key, confirm: true };
    fixtures[0].buildings = [];
    fixtures[0].player.level = 28;
    const blocked = (await respond(accounts[0])).body.status[activityId].chip;
    assert.equal(blocked.key, null);
    assert.match(blocked.blockedReason, /28 级，51 级可建造芯片厂/);
    assert.deepEqual(blocked.statistics.inventory, preview.statistics.inventory);
    const stale = await respond(accounts[0], body);
    assert.notEqual(stale.status, 200);
    assert.match(stale.body.error, /51 级可建造芯片厂/);
    fixtures[0].buildings = [{ buildingId: '1芯片厂', level: 1 }];
    fixtures[0].player.level = 60;
    assert.equal((await respond(accounts[0])).body.status[activityId].chip.key, preview.key);
    assert.notEqual((await respond(accounts[0], { ...body, confirm: false })).status, 200);
    assert.notEqual((await respond(accounts[1], body)).status, 200);
    assert(fixtures.every(f => !f.writes.length));
    const results = await Promise.all([respond(accounts[0], body), respond(accounts[0], body)]);
    assert(results.some(r => r.status === 200), JSON.stringify(results));
    assert.deepEqual(fixtures[0].writes, [['绿芯片宝箱', 1]]);
    assert.equal(fixtures[1].writes.length, 0);
    assert.equal((await respond(accounts[0])).body.status[activityId].chip.key, null);
    const unbuilt = fixtures[1];
    unbuilt.score = 8000;
    unbuilt.gotTaskId = [1,2,3,4,5];
    unbuilt.buildings = [];
    unbuilt.player.chipScore = 500;
    const claimOnly = (await respond(accounts[1])).body.status[activityId].chip;
    assert.deepEqual(claimOnly.actions.map(step => step.kind), ['gift', 'weekly']);
    const claimed = await respond(accounts[1], { ...body, planKey: claimOnly.key });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.deepEqual(claimed.body.claimed, { weekly: 1, gift: 1, factory: 0 });
    assert.equal(unbuilt.writes.length, 0);
    const rebate = (await respond(accounts[2])).body.status[activityId].chip;
    assert.deepEqual([rebate.available, rebate.statistics.weekly, rebate.statistics.gift, rebate.statistics.factory, rebate.statistics.forecast],
      [7489, 500, 10, 1, 8000]);
    const completed = await respond(accounts[2], { ...body, planKey: rebate.key });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const nextRound = (await respond(accounts[2])).body.status[activityId].chip;
    assert.deepEqual([nextRound.round, nextRound.score, nextRound.statistics.completed, nextRound.key], [2, 0, 1, null]);
  } finally { await app.close(); }
});
