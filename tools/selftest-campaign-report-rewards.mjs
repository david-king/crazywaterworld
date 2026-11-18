// 战报分页、定向降级与持久防重专项；默认完全离线，--protocol 另验本机协议编解码。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryParent = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryParent, 'cw-campaign-report-'));
process.env.CW_DATA_DIR = directory;
const { claimReportRewards } = await import('../src/missing-rewards.mjs');
const { createUsageLedger } = await import('../src/usage-ledger.mjs');
const { exactAutomationId } = await import('../src/automation-policy.mjs');
const protocol = process.argv.includes('--protocol') ? (await import('../src/proto.mjs')).loadProtocol() : null;
const wire = (name, value) => protocol ? protocol[name].decode(protocol[name].encode(value).finish()) : structuredClone(value);
const reward = { reward: { asset: [{ id: 'RUBY', num: 20 }] } };
const letter = (index, pending = true) => ({
  uid: String(9007199254740993n + BigInt(index)), received: !pending,
  rewards: { assetPackage: { asset: [{ id: 'RUBY', num: 1 }] } },
});
let serial = 0;
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
const textOf = events => events.map(event => [event.label, event.reason, event.error].filter(Boolean).join(' ')).join('\n');

function fixture(reports = [letter(0)]) {
  const file = path.join(directory, ++serial + '.json');
  const state = { reports, total: reports.length, enabled: true, scans: 0, reads: [], writes: [], update: true, raw: false };
  const events = [];
  const makeLedger = () => createUsageLedger('report-test', { file });
  const ledger = makeLedger();
  const makeClient = () => ({
    async request(name, body, response) {
      if (name === 'CampaignReportsRequest') {
        assert.equal(response, 'CampaignReportsResponse');
        wire(name, body);
        if (body.pageNo === 0) state.scans++;
        state.reads.push(body.pageNo);
        const base = { total: state.total, reports: state.reports.slice(body.pageNo * 10, (body.pageNo + 1) * 10) };
        const value = state.readPage ? await state.readPage(body.pageNo, base) : base;
        await state.afterRead?.(body.pageNo);
        return state.raw ? structuredClone(value) : wire(response, value);
      }
      assert.equal(name, 'QuickGotCampaignReportRequest', '隔离客户端禁止调用无关操作');
      assert.equal(response, 'GotRewardResponse');
      const sent = wire(name, body);
      const ids = (sent.campaignId ?? []).map(exactAutomationId);
      assert(ids.every(Boolean), '指定领取的 UID 必须精确且有效');
      state.writes.push({ all: sent.all === true, ids });
      if (state.update) for (const row of state.reports) {
        if (sent.all || ids.includes(exactAutomationId(row.uid))) row.received = true;
      }
      await state.afterWrite?.();
      return wire(response, state.emptyReward ? {} : reward);
    },
  });
  const client = makeClient();
  const options = { enabled: () => state.enabled, ledger, report: event => events.push(event) };
  return { state, events, ledger, makeLedger, makeClient, options,
    run: (nextClient = client, nextOptions = options) => claimReportRewards(nextClient, {}, nextOptions) };
}

try {
  await check('超过 200 页仍读取最后页奖励，并在完整回读后确认', async () => {
    const f = fixture(Array.from({ length: 2001 }, (_, index) => letter(index, index === 2000)));
    await f.run();
    assert(f.state.reads.includes(200), '必须读到第 201 页');
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.writes[0].all, true);
    assert.equal(f.state.reports[2000].received, true);
    assert(f.events.some(event => event.ok && event.status === 'confirmed'));
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check('瞬时空页重新同步后恢复完整一键领取', async () => {
    const f = fixture(Array.from({ length: 11 }, (_, index) => letter(index, index === 10)));
    f.state.readPage = (pageNo, base) => f.state.scans === 1 && pageNo === 1 ? { ...base, reports: [] } : base;
    await f.run();
    assert(f.state.scans >= 2);
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.writes[0].all, true);
    assert(f.events.some(event => event.ok));
  });

  await check('持续缺页仅定向领取可见 UID，小批执行并说明读取范围', async () => {
    const f = fixture(Array.from({ length: 21 }, (_, index) => letter(index)));
    f.state.readPage = (pageNo, base) => pageNo === 2 ? { ...base, reports: [] } : base;
    await f.run();
    assert(f.state.writes.length >= 2);
    assert(f.state.writes.every(write => !write.all && write.ids.length > 0 && write.ids.length <= 10));
    const sentIds = f.state.writes.flatMap(write => write.ids);
    assert.equal(new Set(sentIds).size, sentIds.length, '同一 UID 不能重复提交');
    assert.deepEqual([...sentIds].sort(), f.state.reports.slice(0, 20).map(row => row.uid).sort());
    assert.equal(f.state.reports[20].received, false, '不可对未读到的战报发送全量领取');
    assert.match(textOf(f.events), /列表|读取|同步/);
    assert(f.events.some(event => event.ok));
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check('重读替换旧快照，消失的旧 UID 不进入定向请求', async () => {
    const f = fixture([letter(0), letter(1)]);
    f.state.readPage = pageNo => ({ total: 2, reports: pageNo === 0 ? [f.state.reports[f.state.scans === 1 ? 0 : 1]] : [] });
    await f.run();
    assert.equal(f.state.writes.length, 1);
    assert.deepEqual(f.state.writes[0], { all: false, ids: [f.state.reports[1].uid] });
    assert.equal(f.state.reports[0].received, false);
    assert(f.events.some(event => event.ok));
  });

  await check('分批之间目标消失或被外部领取时依据新快照跳过，继续领取剩余目标', async () => {
    const f = fixture(Array.from({ length: 20 }, (_, index) => letter(index)));
    const originalIds = f.state.reports.map(row => row.uid);
    f.state.total = 21;
    f.state.afterWrite = () => {
      if (f.state.writes.length !== 1) return;
      f.state.reports[11].received = true;
      f.state.reports.splice(10, 1);
    };
    await f.run();
    assert.equal(f.state.writes.length, 2);
    assert.deepEqual(f.state.writes[0], { all: false, ids: originalIds.slice(0, 10) });
    assert.deepEqual(f.state.writes[1], { all: false, ids: originalIds.slice(12) });
    assert(f.state.reports.every(row => row.received));
    assert.equal(f.events.filter(event => event.ok).length, 2);
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check('分页重复 UID 不凑总数、不发送全量领取', async () => {
    const f = fixture([letter(0), letter(1)]);
    f.state.readPage = pageNo => ({ total: 3, reports: pageNo === 0 ? f.state.reports : [f.state.reports[0]] });
    await f.run();
    assert(f.state.writes.length > 0);
    assert(f.state.writes.every(write => !write.all));
    const ids = f.state.writes.flatMap(write => write.ids);
    assert.deepEqual([...ids].sort(), f.state.reports.map(row => row.uid).sort());
    assert.equal(new Set(ids).size, ids.length);
  });

  await check('分页期间总数降低不能把不完整快照误判为完整', async () => {
    const f = fixture([letter(0), letter(1)]);
    f.state.readPage = pageNo => ({ total: pageNo === 0 ? 3 : 2, reports: pageNo === 0 ? f.state.reports : [] });
    await f.run();
    assert(f.state.writes.length > 0);
    assert(f.state.writes.every(write => !write.all));
    assert(f.events.some(event => event.ok));
  });

  await check('缺页且可见记录无待领时保留未完整说明，不宣称全部领完', async () => {
    const f = fixture([letter(0, false)]);
    f.state.total = 2;
    await f.run();
    assert.equal(f.state.writes.length, 0);
    assert(!f.events.some(event => event.ok));
    assert.match(textOf(f.events), /列表|读取|同步/);
    assert(!f.events.some(event => event.reason === '当前战报没有待领取奖励'));
  });

  await check('定向回读只核对本批 UID，不因历史缺页保持未知', async () => {
    const f = fixture([letter(0)]);
    f.state.total = 2;
    await f.run();
    assert.deepEqual(f.state.writes, [{ all: false, ids: [f.state.reports[0].uid] }]);
    assert(f.events.some(event => event.ok && event.status === 'confirmed'));
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check('目标消失或仍未领取均不报成功，重建客户端和账本仍禁止重发', async () => {
    for (const mode of ['missing', 'unreceived']) {
      const f = fixture([letter(0)]);
      f.state.update = false;
      if (mode === 'missing') f.state.readPage = (_pageNo, base) => f.state.writes.length ? { ...base, reports: [] } : base;
      await f.run();
      assert.equal(f.state.writes.length, 1);
      assert(!f.events.some(event => event.ok));
      assert.equal(f.ledger.snapshot().uncertain, 1);
      const ledger = f.makeLedger();
      await f.run(f.makeClient(), { ...f.options, ledger });
      assert.equal(f.state.writes.length, 1);
      assert.equal(ledger.snapshot().uncertain, 1);
    }
  });

  await check('缺少奖励回执不报本轮成功，下次按已领取 UID 消解记录且不重发', async () => {
    const f = fixture([letter(0)]);
    f.state.emptyReward = true;
    await f.run();
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.state.reports[0].received, true);
    assert(!f.events.some(event => event.ok));
    assert(f.events.some(event => event.status === 'unknown'));
    assert.equal(f.ledger.snapshot().uncertain, 1);
    const ledger = f.makeLedger();
    await f.run(f.makeClient(), { ...f.options, ledger });
    assert.equal(f.state.writes.length, 1);
    assert.equal(ledger.snapshot().uncertain, 0);
    assert(Object.values(ledger.keyRecords()).every(record => record.confirmed));
  });

  await check('旧一键领取未知记录缺少目标或目标未确认时阻断定向降级', async () => {
    for (const claimIds of [undefined, [letter(9).uid], [letter(0).uid]]) {
      const f = fixture([letter(0)]);
      f.state.total = 2;
      f.ledger.reserve({}, {}, {}, { uniqueKey: 'report-all:legacy', details: {
        request: 'QuickGotCampaignReportRequest', ...(claimIds ? { claimIds } : {}),
      } });
      await f.run();
      assert.equal(f.state.writes.length, 0);
      assert.equal(f.ledger.snapshot().uncertain, 1);
      assert(!f.events.some(event => event.ok));
    }
  });

  await check('缺页时旧请求所有目标已确认可解锁，但不重新领取旧目标', async () => {
    const f = fixture([letter(0, false), letter(1)]);
    f.state.total = 3;
    f.ledger.reserve({}, {}, {}, { uniqueKey: 'report-all:legacy', details: {
      request: 'QuickGotCampaignReportRequest', claimIds: [f.state.reports[0].uid],
    } });
    await f.run();
    assert.equal(f.ledger.keyRecords()['report-all:legacy'].confirmed, true);
    assert.deepEqual(f.state.writes, [{ all: false, ids: [f.state.reports[1].uid] }]);
  });

  await check('读取期间暂停不会发送领取或持久占用', async () => {
    const f = fixture(Array.from({ length: 11 }, (_, index) => letter(index)));
    f.state.afterRead = () => { f.state.enabled = false; };
    try { await f.run(); } catch (error) { assert.match(error.message, /暂停|关闭/); }
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check('已发送后暂停仍完成本批只读确认，不继续下一批', async () => {
    const f = fixture(Array.from({ length: 11 }, (_, index) => letter(index)));
    f.state.total = 12;
    f.state.afterWrite = () => { f.state.enabled = false; };
    await f.run();
    assert.equal(f.state.writes.length, 1);
    assert(f.events.some(event => event.ok && event.status === 'confirmed'));
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert(f.state.reports.some(row => !row.received), '暂停后不得领取下一批');
  });

  await check('同一客户端在领取回包挂起期间并发调用只发送一次', async () => {
    const f = fixture([letter(0)]);
    let release;
    let markSent;
    const blocked = new Promise(resolve => { release = resolve; });
    const sent = new Promise(resolve => { markSent = resolve; });
    f.state.afterWrite = async () => { markSent(); await blocked; };
    const first = f.run();
    await Promise.race([sent, first.then(() => { throw Error('首个调用未进入隔离发送回包等待'); })]);
    try {
      await f.run();
      assert.equal(f.state.writes.length, 1);
    } finally {
      release();
      await first;
    }
    assert.equal(f.state.writes.length, 1);
    assert.equal(f.events.filter(event => event.ok).length, 1);
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check('缺少 UID 或非法总数拒绝写入', async () => {
    for (const reply of [
      { total: 1, reports: [{ received: false, rewards: letter(0).rewards }] },
      { total: -1, reports: [letter(0)] },
      { total: 1.5, reports: [letter(0)] },
      { reports: [letter(0)] },
    ]) {
      const f = fixture();
      f.state.raw = true;
      f.state.readPage = () => reply;
      await assert.rejects(f.run());
      assert.equal(f.state.writes.length, 0);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });

  await check('空战报与已领完的完整列表不发送请求', async () => {
    for (const reports of [[], [letter(0, false)]]) {
      const f = fixture(reports);
      await f.run();
      assert.equal(f.state.writes.length, 0);
      assert.equal(f.ledger.snapshot().uncertain, 0);
      assert(f.events.some(event => event.skipped));
    }
  });
  console.log(`战报领奖专项 ${passed}/${passed} 通过${protocol ? '（含真实协议编解码）' : '（离线）'}`);
} finally {
  assert.equal(path.dirname(fs.realpathSync(directory)), temporaryParent);
  fs.rmSync(directory, { recursive: true, force: true });
}
