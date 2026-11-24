// Automatic museum exploration owns dispatch, settlement, and collection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { museumPreview } from '../src/museum-preview.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { defaultSettings } from '../src/automation-settings.mjs';
import { baseDemands, observeBaseAutomationPlan, planBaseAutomation, runBaseAutomation, surveyBaseAutomation } from '../src/base-automation.mjs';

let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
function fixture() {
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.museum, { runEnabled: true, enabled: true, useGuide: true, dailyGuideLimit: 1 });
  settings.factory.keepStock = 0;
  const config = { tables: Object.fromEntries(Object.entries({
    MuseumAchievementCfg: [{ score: 10 }],
    MuseumExpeditionStageCfg: [1, 2, 3].map(stageId => ({ stageId })),
    MuseumExpeditionTeamCfg: [{ playerLevel: 1, teamCount: 3 }],
    MuseumExploreTimeFactorCfg: [{ playerLevel: 1, factor: 1 }],
    MuseumExpeditionConditionCfg: [{ conditionId: 1, heroCount: 1 }],
  }).map(([name, data]) => [name, { data }])) };
  const stock = new Map([['木板', 20], ['博物馆加速', 5]]);
  const snapshot = { now: 1000, player: { level: 30, worldId: 1000001 }, notes: [],
    world: { stock, have: id => stock.get(id) ?? 0, buildings: [], factories: [], serverNow: 1000 },
    museum: { popularity: 10, claimedAchievements: [], exhibitions: [], exploreStages: [
      { stageId: 1, expedition: { endTime: 900, heroIds: ['busy-1'] } },
      { stageId: 2, expedition: { endTime: 4000, heroIds: ['busy-2'] } },
      { stageId: 3, expedition: { endTime: 0, conditionId: 1, cost: { asset: [{ id: '木板', num: 2 }] } } },
    ] }, heroes: [{ heroId: 'available', power: 10 }], choices: [], pets: [] };
  return { settings, config, snapshot };
}

await test('开启自动探宝同时计划探险领奖、派遣及已配置指南', async () => {
  const f = fixture();
  const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert.deepEqual(plan.actions.map(step => step.kind), ['museumComplete', 'museumGuide', 'museumStart']);
  assert(plan.actions.filter(step => step.kind !== 'museumGuide').every(step => step.setting === 'museum.enabled'));
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [{ source: 'museum', requirements: [{ id: '木板', num: 2 }] }]);
  const reads = [];
  await surveyBaseAutomation({ async request(name) { reads.push(name); return f.snapshot.museum; } },
    { MuseumInfoRequest: {}, MuseumInfoResponse: {}, AllHeroRequest: {}, AllHeroResponse: {} },
    f.config, f.snapshot.player, f.settings, f.snapshot.world);
  assert.deepEqual(reads, ['MuseumInfoRequest', 'AllHeroRequest']);
});

await test('关闭自动探宝后领奖、派遣和指南全部停止且不产生材料需求', async () => {
  const f = fixture(); f.settings.museum.enabled = false;
  assert.deepEqual(planBaseAutomation(f.snapshot, f.config, f.settings).actions, []);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), []);
  const reads = [];
  await surveyBaseAutomation({ async request(name) { reads.push(name); return {}; } },
    { MuseumInfoRequest: {}, MuseumInfoResponse: {}, AllHeroRequest: {}, AllHeroResponse: {} },
    f.config, f.snapshot.player, f.settings, f.snapshot.world);
  assert.deepEqual(reads, []);
});

await test('人气币和人气奖励各自独立开启，不依赖自动探宝也不派遣英雄', async () => {
  const f = fixture(); f.settings.museum.enabled = false;
  f.snapshot.museum.uncollectedRevenue = 30;
  for (const [field, kind] of [['revenue', 'museumRevenue'], ['achievements', 'museumAchievement']]) {
    f.settings.museum.revenue = f.settings.museum.achievements = false;
    f.settings.museum[field] = true;
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    assert.deepEqual(plan.actions.map(step => step.kind), [kind]);
    assert.equal(plan.actions[0].setting, 'museum.' + field);
    const reads = [];
    await surveyBaseAutomation({ async request(name) { reads.push(name); return f.snapshot.museum; } },
      { MuseumInfoRequest: {}, MuseumInfoResponse: {}, AllHeroRequest: {}, AllHeroResponse: {} },
      f.config, f.snapshot.player, f.settings, f.snapshot.world);
    assert.deepEqual(reads, ['MuseumInfoRequest']);
    f.settings.museum.runEnabled = false;
    assert.deepEqual(planBaseAutomation(f.snapshot, f.config, f.settings).actions, []);
    assert.deepEqual(await runBaseAutomation({ request() { assert.fail('总开关关闭不得写入'); } }, {}, f.config, plan,
      { getSettings: () => f.settings }), []);
    f.settings.museum.runEnabled = true;
  }
});

await test('人气币使用真实回执确认，零库存不计划且错误回执不报成功', async () => {
  for (const collected of [30, undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.settings.museum.enabled = false; f.settings.museum.revenue = true;
    f.snapshot.museum.uncollectedRevenue = 30;
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    const requests = [];
    const result = await runBaseAutomation({ async request(name) { requests.push(name); return { collected }; } },
      { MuseumCollectRevenueRequest: {}, MuseumCollectRevenueResponse: {} }, f.config, plan, { getSettings: () => f.settings });
    assert.deepEqual(requests, ['MuseumCollectRevenueRequest']);
    assert.equal(result[0].ok, collected === 30);
    f.snapshot.museum.uncollectedRevenue = 0;
    assert.deepEqual(planBaseAutomation(f.snapshot, f.config, f.settings).actions, []);
  }
});

await test('推荐模式派遣计划使用独立的满队和不足满队倍数', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended';
  f.settings.museum.useGuide = false; f.settings.museum.fullRecommendedFactor = 3; f.settings.museum.partialRecommendedFactor = 2;
  f.snapshot.player.level = 40;
  f.config.tables.MuseumExploreTimeFactorCfg.data = [1, 2, 3].map(factor => ({ factor, playerLevel: 1 }));
  Object.assign(f.config.tables.MuseumExpeditionConditionCfg.data[0], { heroCount: 2, heroStar: 2, heroQualityIndex: 3, careerLimit: '战士', factionLimit: '' });
  f.config.tables.HeroCfg = { data: ['available', 'second'].map(id => ({ id, quality: 'ORANGE', career: '战士', faction: '甲' })) };
  f.snapshot.heroes[0].star = 2;
  f.snapshot.heroes.push({ heroId: 'second', star: 2, power: 1 });
  let start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 3); assert.equal(start.costs[0].num, 6);
  f.snapshot.heroes[0].star = 1;
  start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 2); assert.equal(start.costs[0].num, 4);
  f.settings.museum.partialRecommendedFactor = 1;
  start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 1);
});

await test('无推荐英雄默认不派遣也不补产，独立兜底开启后按指定倍率派遣', () => {
  const f = fixture();
  Object.assign(f.settings.museum, { factorMode: 'recommended', noRecommendedFallback: false, noRecommendedFactor: 1, useGuide: false });
  f.config.tables.MuseumExploreTimeFactorCfg.data = [1, 2, 3].map(factor => ({ factor, playerLevel: 1 }));
  Object.assign(f.config.tables.MuseumExpeditionConditionCfg.data[0], { heroStar: 2, heroQualityIndex: 3, careerLimit: '战士', factionLimit: '' });
  f.config.tables.HeroCfg = { data: [{ id: 'available', quality: 'ORANGE', career: '战士', faction: '甲' }] };
  f.snapshot.heroes[0].star = 1;
  let plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'museumStart'));
  assert.match(plan.notesBySetting['museum.enabled'].join('；'), /没有可用的推荐英雄/);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), []);
  f.settings.museum.noRecommendedFallback = true; f.settings.museum.noRecommendedFactor = 3;
  let start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 3); assert.equal(start.costs[0].num, 6);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [{ source: 'museum', requirements: [{ id: '木板', num: 6 }] }]);
  f.snapshot.heroes = [];
  plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'museumStart'));
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [], '没有足够英雄不能按兜底倍率备料');
});

await test('推荐条件未知时既不派遣也不补产，切回材料模式不受兜底开关影响', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended'; f.settings.museum.noRecommendedFallback = true;
  let plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'museumStart'));
  assert.match(plan.notesBySetting['museum.enabled'].join('；'), /未确认推荐英雄/);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), []);
  f.settings.museum.factorMode = 'materials'; f.settings.museum.noRecommendedFallback = false;
  plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(plan.actions.some(step => step.kind === 'museumStart'));
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [{ source: 'museum', requirements: [{ id: '木板', num: 2 }] }]);
});

await test('关闭兜底或修改兜底倍率会使已生成的派遣计划失效', async () => {
  for (const change of [settings => { settings.museum.noRecommendedFallback = false; }, settings => { settings.museum.noRecommendedFactor = 2; }]) {
    const f = fixture();
    Object.assign(f.settings.museum, { factorMode: 'recommended', noRecommendedFallback: true, noRecommendedFactor: 1, useGuide: false });
    Object.assign(f.config.tables.MuseumExpeditionConditionCfg.data[0], { heroStar: 2, heroQualityIndex: 3, careerLimit: '战士', factionLimit: '' });
    f.config.tables.HeroCfg = { data: [{ id: 'available', quality: 'ORANGE', career: '战士', faction: '甲' }] };
    f.snapshot.heroes[0].star = 1;
    const actions = planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumStart');
    assert.equal(actions.length, 1);
    change(f.settings);
    const result = await runBaseAutomation({ request() { assert.fail('派遣设置变化后不能执行旧计划'); } }, {}, f.config, { actions }, { getSettings: () => f.settings });
    assert.equal(result[0].skipped, true);
    assert.match(result[0].error, /设置已变化/);
  }
});

await test('每轮派遣上限保留旧单队行为，0 允许填满空闲队伍', () => {
  const f = fixture();
  f.settings.museum.useGuide = false;
  f.snapshot.museum.exploreStages = [1, 2, 3].map(stageId => ({ stageId,
    expedition: { endTime: 0, conditionId: 1, cost: { asset: [{ id: '木板', num: 2 }] } } }));
  f.snapshot.heroes = [1, 2, 3].map(id => ({ heroId: 'hero-' + id, power: id }));
  f.settings.museum.maxDispatches = 1;
  assert.equal(planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumStart').length, 1);
  f.settings.museum.maxDispatches = 0;
  assert.equal(planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumStart').length, 3);
});

await test('已生成计划在关闭自动探宝后不继续执行任何动作', async () => {
  const f = fixture();
  const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  f.settings.museum.enabled = false;
  const client = { request() { assert.fail('关闭动作后不能发请求'); }, sendWatch() { assert.fail('关闭动作后不能写入'); } };
  assert.deepEqual(await runBaseAutomation(client, {}, f.config, plan, { getSettings: () => f.settings }), []);
});

await test('两队配合保留稀缺战士，目标碎片的星级筛选同步影响预览、派遣和备料', () => {
  const { settings, config, snapshot } = fixture(), tables = config.tables;
  Object.assign(settings.museum, { factorMode: 'recommended', useGuide: false, maxDispatches: 0 });
  tables.MuseumExpeditionConditionCfg.data = [1,2].map(i => ({ conditionId: i, heroCount: 1, heroStar: 0,
    heroEvalScore: 100, heroQualityIndex: 1, careerLimit: i === 2 ? '战士' : '', factionLimit: '' }));
  tables.HeroCfg = { data: [{ id:'甲', quality:'BLUE', career:'战士' },{ id:'乙', quality:'BLUE', career:'法师' }] };
  tables.MuseumStageStarCfg = { data: [{ star: 1, exploreValue: 250 }] };
  tables.MuseumExpeditionRewardCfg = { data: [1,2].map(stageId => ({ stageId, star: stageId-1, baseEvalScore:0,
    randomRewards:[['文物碎片',1]], randomRewardWeights:[100] })) };
  tables.MuseumExpeditionEvalCfg = { data: [{ evalScore:100, evalTiers:[2,1], evalWeights:[15,85] }] };
  snapshot.heroes = [{ heroId:'甲', power:100 },{ heroId:'乙', power:10 }];
  snapshot.museum.exploreStages = [1,2].map(stageId => ({ stageId, progress:200, expedition:{ conditionId:stageId, cost:{asset:[{id:'木板',num:2}]} } }));
  const preview = () => museumPreview(snapshot, [], config, settings, {});
  const both = preview().actions.filter(a => a.kind === 'museumStart');
  assert.deepEqual(both.map(s => [s.body.stageId,s.body.heroIds]), [[1,['乙']],[2,['甲']]]);
  settings.museum.maxDispatches = 1;
  assert.deepEqual(preview().actions.map(s=>s.body.heroIds), [['乙']], '每轮只发一队也保留下一队需要的战士');
  settings.museum.targetFragments = ['文物碎片'];
  const view = preview();
  assert.deepEqual(view.actions.map(a => a.body.stageId), [1]);
  assert.match(view.maps[0].odds, /C 15%.*D 85%/);
  assert.equal(view.drops.find(r=>r.first===1).status,'距 1 星还差 50 进度');
  assert.equal(baseDemands(snapshot,config,settings).length,1);
  settings.museum.maps=['2'];
  assert.equal(preview().actions.length,0);
  snapshot.museum.exploreStages[1].progress=250;
  assert.equal(preview().actions[0].body.stageId,2);
});

await test('结算期间关闭自动探宝时不继续发送奖励领取', async () => {
  const f = fixture();
  const stage = f.snapshot.museum.exploreStages[0];
  stage.progress = 100;
  stage.expedition.startTime = 10;
  const actions = planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumComplete');
  const requests = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-museum-claim-'));
  const ledger = () => createUsageLedger('claim-test', { file: path.join(directory, 'ledger.json') });
  const player = { playerId: '42', worldId: 1000001 };
  let claims = 0;
  const client = { connected: true, async request(name) {
    requests.push(name);
    if (name === 'MuseumInfoRequest') return f.snapshot.museum;
    if (name === 'MuseumRewardRequest') {
      claims++;
      return { reward: { asset: [{ id: '人气币', num: 5 }] }, exploreStage: { stageId: 1, progress: 105 } };
    }
    assert.equal(name, 'MuseumCompleteExploreRequest');
    f.settings.museum.enabled = false;
    return { grade: 2, progressGain: 5 };
  } };
  const protocol = Object.fromEntries(['MuseumInfo','MuseumCompleteExplore','MuseumReward'].flatMap(n => [[n+'Request',{}],[n+'Response',{}]]));
  const run = () => runBaseAutomation(client, protocol, f.config, { actions }, { getSettings: () => f.settings, ledger: ledger(), player });
  try {
    assert.equal((await run())[0].ok, false);
    assert.equal(claims, 0);
    f.settings.museum.enabled = true;
    assert.equal((await run())[0].ok, true);
    assert.equal((await run())[0].ok, false, '过期计划不能重领');
    assert.equal(claims, 1);
    assert.equal(requests.filter(name => name === 'MuseumCompleteExploreRequest').length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

await test('领奖丢回包后等待同一趟的进度变化，下一轮即使没有到期任务也能清理记录', async () => {
  const f = fixture();
  const stage = { stageId: 1, progress: 100, expedition: { startTime: 10, endTime: 900, heroIds: ['甲'] } };
  f.snapshot.museum.exploreStages = [stage];
  const player = { playerId: 43, worldId: 1000001 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-museum-unknown-'));
  try {
    const ledger = createUsageLedger('role', { file: path.join(directory, 'usage.json') });
    const writes = [];
    const client = { connected: true, async request(name) {
      if (name === 'MuseumInfoRequest') return f.snapshot.museum;
      writes.push(name);
      if (name === 'MuseumCompleteExploreRequest') return { grade: 3, progressGain: 25 };
      throw new Error('领取回包超时');
    } };
    const protocol = Object.fromEntries(['MuseumInfo','MuseumCompleteExplore','MuseumReward'].flatMap(n => [[n+'Request',{}],[n+'Response',{}]]));
    const run = () => runBaseAutomation(client, protocol, f.config, planBaseAutomation(f.snapshot, f.config, f.settings),
      { getSettings: () => f.settings, ledger, player });
    assert.equal((await run())[0].ok, false);
    assert.equal((await run())[0].ok, false);
    assert.deepEqual(writes, ['MuseumCompleteExploreRequest','MuseumRewardRequest']);
    assert.equal(ledger.snapshot().uncertain, 1);
    f.snapshot.museum.exploreStages = [{ stageId: 1, progress: 125 }];
    await run();
    assert.equal(ledger.snapshot().uncertain, 0);
    assert.deepEqual(ledger.keyRecords(), {});
    assert.equal(writes.length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

await test('指南预检读取库存期间关闭自动探宝后不能继续消费指南', async () => {
  const f = fixture();
  const actions = planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumGuide');
  const requests = [];
  const client = { connected: true, async request(name) {
    requests.push(name);
    assert.equal(name, 'AllItemRequest');
    f.settings.museum.enabled = false;
    return { items: [{ itemId: '博物馆加速', num: 5 }] };
  } };
  const protocol = { MuseumSpeedUpExploreRequest: {}, MuseumSpeedUpExploreResponse: {} };
  const result = await runBaseAutomation(client, protocol, f.config, { actions }, { getSettings: () => f.settings });
  assert.equal(result[0].ok, false);
  assert.deepEqual(requests, ['AllItemRequest']);
});

await test('自动探宝状态统一汇总领奖派遣与指南', () => {
  const f = fixture();
  const notes = new Map();
  observeBaseAutomationPlan({ now: () => 1000, observe: (key, text) => notes.set(key, text), expect() {} },
    planBaseAutomation(f.snapshot, f.config, f.settings), f.settings, 30000);
  assert.match(notes.get('museum.enabled'), /本次计划 3 项/);
  assert.match(notes.get('museum.useGuide'), /本次计划 1 项/);
  assert.deepEqual([...notes.keys()].sort(), ['museum.enabled', 'museum.runEnabled', 'museum.useGuide']);
});

await test('迁移后的海兽培育未选择品种时明确等待选择', () => {
  const f = fixture();
  f.settings.museum.enabled = false;
  f.settings.pet.enabled = f.settings.pet.breed = true;
  const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'petBreed'));
  assert.match(plan.notesBySetting['pet.breed'].join('；'), /请先选择培育品种/);
});

console.log(`博物馆动作控制测试：${passed} 项通过`);
