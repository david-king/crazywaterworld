import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAction } from '../src/actions.mjs';
import { defaultSettings, migrateSettingsVersion } from '../src/automation-settings.mjs';
import { claimRewards } from '../src/claim-rewards.mjs';
import { dailyCardKeys, dailyCardRewards } from '../src/daily-card-rewards.mjs';
import { surveyDailies } from '../src/dailies.mjs';
import { runLoop } from '../src/loop.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-daily-cards-'));
const monthly = 'MonthCardDailyRewardRequest', seasonal = 'SeasonCardGotDailyRequest';
const names = [monthly, seasonal, 'MonthCardRequest', 'MonthCardResponse', 'SeasonCardRequest', 'SeasonCardResponse',
  'DailyTaskInfoRequest', 'DailyTaskInfoResponse', 'AllResourceRequest', 'AllResourceResponse'];
const protocol = process.env.CW_TEST_CARD_CODEC === '1' ? (await import('../src/proto.mjs')).getProtocol() : createDeclaredProtocol(names);
let serial = 0, passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

function fixture() {
  const client = new EventEmitter();
  client.setMaxListeners(32);
  Object.assign(client, { connected: true, serverClockOffsetMs: 0 });
  const file = path.join(dir, ++serial + '.json');
  const ledger = createUsageLedger('role', { file });
  const settings = defaultSettings();
  settings.dailies.enabled = true;
  Object.assign(settings.schedule, { monthCardDaily: true, seasonCardDaily: true });
  const state = {
    months: [1, 2].map(type => ({ type, endTime: -1, gotDailyReward: false })),
    season: { isPaid: true, gotDaily: false, customId: [1, 2, 3] },
  };
  const writes = [], reads = [];
  const wire = (name, body) => protocol[name].decode(protocol[name].encode(body).finish());
  client.request = async (name, body, response) => {
    reads.push(name);
    wire(name, body);
    const reply = ({
      MonthCardRequest: { cardItem: state.months }, SeasonCardRequest: state.season,
      DailyTaskInfoRequest: { dailyTask: [] }, AllResourceRequest: { list: [] },
    })[name];
    assert(reply, name);
    return wire(response, reply);
  };
  client.sendWatch = async (name, body, { beforeSend }) => {
    beforeSend();
    assert([monthly, seasonal].includes(name));
    const decoded = wire(name, body);
    writes.push([name, decoded.type ?? null]);
    if (name === monthly) state.months.find(row => row.type === decoded.type).gotDailyReward = true;
    else state.season.gotDaily = true;
  };
  const enabled = key => dailyCardKeys.includes(key);
  const claim = scheduler => claimRewards(client, protocol, null, undefined, enabled, undefined, scheduler, null, { settings, ledger });
  return { client, settings, ledger, file, reads, writes, state, claim, enabled };
}

try {
  await test('只读预览列出三项，日常总开关和两项子开关分别生效', async () => {
    const f = fixture();
    const preview = () => surveyDailies(f.client, protocol, { settings: f.settings, ledger: f.ledger, probeGift: false });
    const before = await preview();
    assert.deepEqual(before.cards.map(card => card.state), Array(3).fill('claimable'));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.ledger.keyRecords(), {});
    f.settings.dailies.enabled = false;
    f.reads.length = 0;
    assert.deepEqual((await preview()).cards, []);
    assert.deepEqual(await f.claim(), []);
    assert(!f.reads.some(name => /Card/.test(name)));
    f.settings.dailies.enabled = true;
    f.settings.schedule.monthCardDaily = false;
    assert.equal((await f.claim()).filter(row => row.ok).length, 1);
    assert.deepEqual(f.writes, [[seasonal, null]]);
    f.settings.schedule.seasonCardDaily = false;
    f.settings.schedule.monthCardDaily = true;
    await f.claim();
    assert.deepEqual(f.writes, [[seasonal, null], [monthly, 1], [monthly, 2]]);
  });

  await test('挂机按普通、高级、赛季卡独立领取，一键领取复查，跨日重新开放', async () => {
    const f = fixture(), scheduler = rewardSchedule(f.client);
    const now = scheduler.now();
    f.state.months[1].endTime = now + 2 * 86400;
    f.settings.loop.world = f.settings.loop.dailies = f.settings.loop.tasks = false;
    await runLoop(f.client, protocol, { config: { tables: {} }, player: { level: 37, worldId: 1001001 },
      rounds: 1, allowMutate: true, isEnabled: f.enabled, getSettings: () => f.settings, usageLedger: f.ledger });
    assert.deepEqual(f.writes, [[monthly, 1], [monthly, 2], [seasonal, null]]);
    for (const key of dailyCardKeys) {
      assert.equal(scheduler.status(key).state, 'completed');
      assert.equal(scheduler.nextCheck(key), scheduler.nextDay());
    }
    const already = await f.claim();
    assert(already.length === 3 && already.every(row => !row.ok && row.skipped && row.status === 'completed'));
    assert.equal(f.writes.length, 3);
    f.client.serverClockOffsetMs += 86400 * 1000;
    f.state.months.forEach(card => { card.gotDailyReward = false; });
    f.state.season.gotDaily = false;
    const next = await f.claim(scheduler);
    assert(next.length === 3 && next.every(row => row.ok && row.status === 'confirmed'));
    assert.equal(f.writes.length, 6);
  });

  await test('过期月卡、未开通或没有选满三项的赛季卡不发送领取', async () => {
    const f = fixture();
    f.state.months[0].endTime = Math.floor(Date.now() / 1000) - 1;
    f.state.months[1].gotDailyReward = true;
    f.state.season.isPaid = false;
    let rows = await f.claim();
    assert.deepEqual(rows.map(row => row.status), ['completed', 'waiting']);
    f.state.season.isPaid = true;
    f.state.season.customId = [1, 2];
    rows = await f.claim();
    assert.equal(rows.at(-1).status, 'setup');
    assert.match(rows.at(-1).note, /选满三项/);
    assert.match(rows.at(-1).note, /2\/3/);
    assert.equal(f.writes.length, 0);
  });

  await test('请求结果未知时保留记录，重连不重复发送，回读后确认', async () => {
    const f = fixture();
    f.client.sendWatch = async (name, body, { beforeSend }) => {
      beforeSend(); f.writes.push([name, body]); throw Error('模拟断线');
    };
    const options = { claim: true, ledger: f.ledger };
    const run = (client, ledger) => dailyCardRewards(client, protocol, 'seasonCardDaily', { ...options, ledger });
    assert.equal((await run(f.client, f.ledger))[0].state, 'pending');
    const reopened = createUsageLedger('role', { file: f.file });
    const reconnect = fixture().client;
    reconnect.request = f.client.request;
    reconnect.sendWatch = f.client.sendWatch;
    assert.equal((await run(reconnect, reopened))[0].state, 'pending');
    assert.equal(f.writes.length, 1);
    f.state.season.gotDaily = true;
    assert.equal((await run(reconnect, reopened))[0].state, 'completed');
    assert(Object.values(reopened.keyRecords())[0].confirmed);
  });

  await test('排队期间关掉开关不发送，明确被拒绝后才允许重试', async () => {
    const f = fixture();
    const send = f.client.sendWatch;
    f.client.sendWatch = async (name, body, options) => {
      f.settings.schedule.seasonCardDaily = false;
      return send(name, body, options);
    };
    f.settings.schedule.monthCardDaily = false;
    assert.equal((await f.claim())[0].status, 'waiting');
    assert.deepEqual(f.ledger.keyRecords(), {});
    f.settings.schedule.seasonCardDaily = true;
    f.client.sendWatch = async name => { throw Object.assign(Error('模拟拒领'), { prompt: true, request: name }); };
    assert.equal((await f.claim())[0].status, 'error');
    assert.deepEqual(f.ledger.keyRecords(), {});
    f.client.sendWatch = send;
    assert((await f.claim())[0].ok);
    assert.deepEqual(f.writes, [[seasonal, null]]);
  });

  await test('手动月卡使用实际卡类型，已领和非法类型均不发请求', async () => {
    const f = fixture();
    const take = (params) => runAction(f.client, protocol, 'monthCardDaily', params, { allowMutate: true, ledger: f.ledger });
    await assert.rejects(take({ type: 0 }), /月卡类型/);
    assert.equal((await take({})).sent, monthly);
    assert.equal((await take({ type: '2' })).sent, monthly);
    assert.equal((await take({ type: '1' })).sent, null);
    assert.deepEqual(f.writes, [[monthly, 1], [monthly, 2]]);
  });

  await test('月卡发送后回读失败先等同步，另一张已由游戏领取时不会重发', async () => {
    const f = fixture();
    f.settings.schedule.seasonCardDaily = false;
    const read = f.client.request;
    f.client.request = async (...args) => {
      if (f.writes.length) throw Error('模拟回读超时');
      return read(...args);
    };
    assert.equal((await f.claim())[0].status, 'pending');
    assert.deepEqual(f.writes, [[monthly, 1]]);
    f.client.request = read;
    f.state.months[1].gotDailyReward = true;
    const rows = await f.claim();
    assert.deepEqual(rows.map(row => row.status), ['completed', 'completed']);
    assert.deepEqual(f.writes, [[monthly, 1]]);
  });

  await test('升级第56版配置默认关闭卡奖励，保留日常总开关与原有选择', () => {
    const old = defaultSettings();
    old.dailies.enabled = true;
    old.dailies.claimGift = true;
    delete old.schedule.monthCardDaily;
    delete old.schedule.seasonCardDaily;
    const next = migrateSettingsVersion(old, 56);
    assert.deepEqual(next, { ...old, schedule: { ...old.schedule, monthCardDaily: false, seasonCardDaily: false } });
  });
  console.log('每日卡奖励：' + passed + ' 项通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
