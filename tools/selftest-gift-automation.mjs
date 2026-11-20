import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-gift-auto-'));
process.env.CW_DATA_DIR = path.join(directory, 'accounts');
const { createGiftCodeLibrary, publicGiftCodes, parseGiftCodeArticle, GIFT_CODE_SOURCE, GIFT_CODE_WIKI } = await import('../src/gift-code-library.mjs');
const { createGiftCodeAutomation } = await import('../src/gift-code-automation.mjs');
const { giftCodeStatus } = await import('../src/gift-codes.mjs');
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const article = codes => '<h1>疯狂水世界兑换码</h1><p>更新时间：2026-11-19 08:01:00</p><h2>一、兑换码</h2>'
  + codes.map(code => '<p>' + code + '</p>').join('') + '<h2>二、使用方式</h2><p>游戏内兑换</p>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(id) {
  for (let count = 0; count < 200; count++) {
    if (!giftCodeStatus(id).running) { await sleep(0); return; }
    await sleep(20);
  }
  throw Error('fixture job did not finish');
}

try {
  await test('解析固定来源文章并拒绝非游戏页面、结构变化与非法日期', () => {
    const parsed = parseGiftCodeArticle(article(['ABC', '中文码（有效期至2026/11/20）', 'ABC']));
    assert.deepEqual(parsed.rows, [{ code: 'ABC', expiresAt: null }, { code: '中文码', expiresAt: '2026-11-20' }]);
    for (const html of ['<p>无关页面</p>', '<p>疯狂水世界</p>', article(['ABC', 'bad!']), article(['ABC（有效期至2026/02/30）'])]) {
      assert.throws(() => parseGiftCodeArticle(html));
    }
  });

  await test('首次同步失败保留内置码库，成功后优先动态库，同日只抓一次', async () => {
    let clock = Date.parse('2026-11-18T23:59:59Z'), calls = 0, fail = true;
    const library = createGiftCodeLibrary({ directory: path.join(directory, 'sync'), now: () => clock,
      catalog: () => ({ source: 'bundled', codes: [{ code: 'OFFLINE', expiresAt: null }] }),
      fetcher: async (url, options) => {
        calls++; assert.equal(url, GIFT_CODE_SOURCE); assert.equal(options.redirect, 'error');
        if (fail) throw Error('fixture offline');
        return new Response(article(['ONLINE', 'EXPIRED（有效期至2026/11/18）']));
      } });
    library.setChannelEnabled('game-wiki', false);
    assert.equal(library.due(), false, '北京时间八点前不定时同步');
    clock++;
    clock += 999;
    assert.equal(library.due(), true);
    await assert.rejects(library.refresh(), /fixture offline/);
    assert.deepEqual(library.entries().map(row => row.code), ['OFFLINE']);
    assert.equal(library.view().sourceKind, 'bundled');
    await library.refresh(); assert.equal(calls, 1, '失败后自动同步有退避');
    clock += 60000; fail = false;
    library.addManualBatch(['MANUAL']);
    await library.refresh({ force: true });
    assert.deepEqual(library.entries().map(row => row.code), ['ONLINE', 'MANUAL']);
    assert.equal(library.view().sourceKind, 'synced');
    assert(library.isExpired('EXPIRED'));
    assert.equal(library.due(), false);
    await library.refresh({ force: true }); assert.equal(calls, 2);
    clock += 86400000; fail = true;
    await assert.rejects(library.refresh(), /fixture offline/);
    assert.deepEqual(library.entries().map(row => row.code), ['ONLINE', 'MANUAL']);
  });

  await test('并发同步合并为一份请求，内容异常不覆盖已同步数据', async () => {
    let clock = Date.parse('2026-11-19T01:00:00Z'), release, calls = 0, broken = false;
    const library = createGiftCodeLibrary({ directory: path.join(directory, 'concurrent'), now: () => clock,
      fetcher: async () => { calls++; if (!broken) await new Promise(resolve => { release = resolve; }); return new Response(broken ? article(['bad!']) : article(['GOOD'])); } });
    library.setChannelEnabled('game-wiki', false);
    const first = library.refresh(), second = library.refresh();
    release(); await Promise.all([first, second]); assert.equal(calls, 1);
    clock += 86400000; broken = true;
    await assert.rejects(library.refresh());
    assert.deepEqual(library.entries().map(row => row.code), ['GOOD']);
  });

  await test('旧缓存自动加入 Wiki，两个默认渠道独立同步，重叠码取较早的到期日', async () => {
    const location = path.join(directory, 'default-channels');
    fs.mkdirSync(location);
    fs.writeFileSync(path.join(location, 'public-gift-codes.json'), JSON.stringify({ version: 1,
      codes: [{ code: 'SHARED', expiresAt: null }], expired: [], lastSuccessAt: '2026-11-19T00:00:00Z' }));
    let clock = Date.parse('2026-11-19T04:00:00Z');
    let wiki = { updated_at: '2026-11-19T08:00:00', codes: [
      { code: 'SHARED', status: 'valid', expires_at: '2026-11-22T23:59:00' },
      { reward: '礼包{钻石}', feedback: { code: 'NESTED', status: 'invalid' }, status: 'valid', expires_at: null, code: '中文码' },
      { code: 'FUTURE', status: 'valid', starts_at: '2026-11-21T00:00:00' },
      { code: 'EXPIRED', status: 'valid', expires_at: '2026-11-19T10:00:00' },
      { code: 'PENDING', feedback: { code: 'NESTED', status: 'valid' }, status: 'pending_review' }, { code: 'INVALID', status: 'invalid' },
    ], candidates: [{ code: 'NOT_YET', status: 'valid' }], expired: [{ code: 'OLD' }] };
    const calls = [];
    const options = { directory: location, now: () => clock, fetcher: async url => {
      calls.push(url);
      if (url === GIFT_CODE_WIKI) return Response.json(wiki);
      assert.equal(url, GIFT_CODE_SOURCE);
      return new Response(article(['SHARED', 'ARTICLE']));
    } };
    const library = createGiftCodeLibrary(options);
    assert.deepEqual(library.channels().map(row => [row.name, row.enabled]), [['疯狂水世界 Wiki', true], ['游侠网', true]]);
    await library.refresh();
    assert.deepEqual(calls, [GIFT_CODE_WIKI], '游侠网当日旧缓存仍然生效');
    assert.deepEqual(library.available([]), ['SHARED', '中文码']);
    assert.equal(library.entries()[0].expiresAt, '2026-11-22');
    clock += 86400000;
    wiki = { error: '暂时不可用' };
    await assert.rejects(library.refresh(), /Wiki/);
    assert.deepEqual(library.available([]), ['SHARED', 'ARTICLE', '中文码']);
    wiki = { codes: [{ code: '中文码', status: 'invalid' }] };
    clock += 61000;
    await library.refresh({ force: true });
    assert.deepEqual(library.available([]), ['SHARED', 'ARTICLE'], '明确下架后更新 Wiki 快照');
    library.setChannelEnabled('game-wiki', false);
    assert.deepEqual(createGiftCodeLibrary(options).channels().map(row => row.enabled), [false, true]);
  });

  await test('两个默认渠道均可改名、改网址和规则，刷新后按保存的规则提取', async () => {
    const options = { directory: path.join(directory, 'edit-defaults'), fetcher: async url => {
      if (url === GIFT_CODE_SOURCE) return new Response(article(['ARTICLE']));
      if (url === GIFT_CODE_WIKI) return Response.json({ codes: [{ code: 'WIKI', status: 'valid' }] });
      return new Response('公告编号：' + new URL(url).pathname.slice(1));
    } };
    const library = createGiftCodeLibrary(options);
    await library.refresh();
    const expected = { text: 'ARTICLE', raw: 'WIKI' };
    for (const source of library.channels()) {
      const renamed = { ...source, name: source.name + '公告' };
      assert.deepEqual(await library.previewChannel(renamed), [expected[source.mode]]);
      library.saveChannel(renamed);
      assert.equal(library.channels().find(row => row.id === source.id).lastSuccessAt, source.lastSuccessAt);
      const draft = { ...renamed, mode: 'raw', jsonField: '', pattern: '编号：([A-Za-z0-9-]+)', url: 'https://example.org/' + source.id };
      assert.deepEqual(await library.previewChannel(draft), [source.id]);
      assert.throws(() => library.saveChannel({ ...draft, pattern: '(' }), /正则/);
      library.saveChannel(draft);
      assert(!library.available([]).includes(expected[source.mode]));
    }
    const restarted = createGiftCodeLibrary(options);
    assert.deepEqual(restarted.available([]), []);
    await restarted.refresh();
    assert.deepEqual(restarted.available([]).sort(), ['ali213', 'game-wiki']);
    for (const channel of restarted.channels()) {
      assert(channel.name.endsWith('公告'));
      assert.equal(channel.url, 'https://example.org/' + channel.id);
      assert.equal(channel.mode, 'raw');
      assert.equal(channel.pattern, '编号：([A-Za-z0-9-]+)');
    }
  });

  await test('旧专用模式转换成可编辑正则，自定义规则、网址、开关和缓存保留', async () => {
    const location = path.join(directory, 'migrate-patterns');
    fs.mkdirSync(location);
    const cache = { enabled: false, lastSuccessAt: '2026-11-19T00:00:00Z', codes: [{ code: 'CACHED', expiresAt: null }] };
    const custom = { ...cache, id: 'mine', name: '我的规则', url: 'https://example.org/page', mode: 'raw', pattern: 'special=(.+)' };
    const oldWiki = { ...cache, mode: 'wiki', pattern: '', name: '已有渠道', url: 'https://example.org/api' };
    fs.writeFileSync(path.join(location, 'public-gift-codes.json'), JSON.stringify({
      version: 1, ...cache, mode: 'article', pattern: '', expired: [], wiki: oldWiki,
      channels: [custom, { ...oldWiki, id: 'legacy-copy' }],
    }));
    const library = createGiftCodeLibrary({ directory: location });
    const [wiki, article, mine, copy] = library.channels();
    assert.equal(wiki.mode, 'raw'); assert.equal(wiki.jsonField, 'codes'); assert(wiki.pattern.includes('(?<code>'));
    assert.equal(wiki.url, oldWiki.url); assert.equal(wiki.name, oldWiki.name); assert.equal(wiki.enabled, false);
    assert.equal(article.mode, 'text'); assert(article.pattern.includes('(?<code>'));
    assert.equal(mine.pattern, custom.pattern); assert.equal(mine.jsonField, ''); assert.equal(copy.pattern, wiki.pattern);
    library.saveChannel({ ...wiki, name: '改名' });
    assert.equal(createGiftCodeLibrary({ directory: location }).channels()[0].lastSuccessAt, cache.lastSuccessAt);
    library.setChannelEnabled('game-wiki', true);
    assert.deepEqual(library.available([]), ['CACHED']);
  });

  await test('自动兑换默认关闭，设置按账号持久保存且删除账号保留共享码', () => {
    const location = path.join(directory, 'preferences');
    const library = createGiftCodeLibrary({ directory: location });
    assert.equal(library.auto('one').enabled, false);
    library.addManualBatch(['SHARED']);
    library.setAuto('one', true);
    assert.equal(library.auto('two').enabled, false);
    assert.equal(createGiftCodeLibrary({ directory: location }).auto('one').enabled, true);
    library.removeAccount('one');
    assert.equal(library.auto('one').enabled, false);
    assert(library.entries().some(row => row.code === 'SHARED'));
  });

  await test('预览和同步使用同一提取规则，按渠道缓存、失败隔离、按码去重', async () => {
    let clock = Date.parse('2026-11-19T01:00:00Z');
    const pages = new Map([
      [GIFT_CODE_SOURCE, article(['SHARED'])],
      [GIFT_CODE_WIKI, '{"codes":[]}'],
      ['https://example.org/news', '<p>礼包码：<b>中文_码</b></p><p>兑换码：SHARED</p><p>兑换码：中文_码</p>'],
      ['https://example.org/data', '{"code":"JSON-1"}'],
    ]);
    const directoryForChannels = path.join(directory, 'sources');
    const options = { directory: directoryForChannels, now: () => clock, fetcher: async url => new Response(pages.get(url)) };
    const library = createGiftCodeLibrary(options);
    const news = { name: '公告', url: 'https://example.org/news', mode: 'text', pattern: '(礼包码|兑换码)：(?<code>[\\p{L}\\p{N}_-]+)' };
    const api = { name: '接口', url: 'https://example.org/data', mode: 'raw', pattern: '"code":"([^"]+)"' };
    assert.deepEqual(await library.previewChannel(news), ['中文_码', 'SHARED']);
    assert.equal(library.channels().length, 2);
    assert(!library.available([]).includes('中文_码'));
    const { id } = library.saveChannel(news);
    library.saveChannel(api);
    await library.refresh();
    assert.deepEqual(library.available([]), ['SHARED', '中文_码', 'JSON-1']);
    assert.deepEqual(createGiftCodeLibrary(options).channels(), library.channels());
    assert.deepEqual(await library.previewChannel({ ...api, pattern: 'JSON-1' }), ['JSON-1']);
    for (const pattern of ['[', 'absent', '("code")']) {
      await assert.rejects(library.previewChannel({ ...api, pattern }));
    }
    clock += 86400000;
    pages.set(news.url, '<p>改版中</p>'); pages.set(api.url, '{"code":"JSON-2"}');
    await assert.rejects(library.refresh(), /公告.*未匹配/);
    assert.deepEqual(library.available([{ code: 'SHARED', status: 'used' }]), ['中文_码', 'JSON-2']);
    library.setChannelEnabled(id, false);
    assert.deepEqual(library.available([]), ['SHARED', 'JSON-2']);
    library.setChannelEnabled(id, true);
    library.addManualBatch(['中文_码']);
    library.removeChannel(id);
    library.setChannelEnabled('ali213', false);
    assert.deepEqual(library.available([]), ['JSON-2', '中文_码']);
  });

  await test('修改规则后，旧请求的迟到响应不能写回新规则', async () => {
    let release;
    const library = createGiftCodeLibrary({ directory: path.join(directory, 'edit-source'), fetcher: async url => {
      if (url.endsWith('/old')) await new Promise(resolve => { release = resolve; });
      return new Response(url.endsWith('/old') ? 'OLD' : 'NEW');
    } });
    library.setChannelEnabled('ali213', false);
    library.setChannelEnabled('game-wiki', false);
    const config = { name: '公告', url: 'https://example.org/old', pattern: 'OLD' };
    const { id } = library.saveChannel(config);
    const old = library.refresh();
    library.saveChannel({ ...config, id, url: 'https://example.org/new', pattern: 'NEW' });
    await library.refresh();
    release(); await old;
    assert.deepEqual(library.available([]), ['NEW']);
    assert.equal(library.due(), false);
  });

  // Use the production redemption pipeline, narrowing the library to fixture
  // codes so the bundled real-world catalog is never submitted to any client.
  const harness = (id, codeList, { paused = false, hold = false } = {}) => {
    let clock = Date.now(), accounts = [{ id }], release;
    const preferences = createGiftCodeLibrary({ directory: path.join(directory, 'pref-' + id), now: () => clock });
    publicGiftCodes.addManualBatch(codeList);
    const library = { ...preferences, entries: () => publicGiftCodes.entries().filter(row => codeList.includes(row.code)),
      available: rows => publicGiftCodes.available(rows).filter(code => codeList.includes(code)),
      accountRevision: () => codeList.join(','), pruneExpired() {}, reconcile: rows => publicGiftCodes.reconcile(rows) };
    const sent = [], messages = [];
    const client = { async request(name, body) { assert.equal(name, 'GotGiftCodeRequest'); sent.push(body.giftCode); return { reward: { asset: [{ id: 'RUBY', num: 1 }] } }; } };
    const auto = createGiftCodeAutomation({ library, accounts: () => accounts, refresh: false, now: () => clock, report: message => messages.push(message),
      targetFor: () => ({ blocked: paused ? '账号已暂停托管' : '', dispatch: action => hold
        ? new Promise(resolve => { release = resolve; }).then(() => action(client, () => !paused)) : action(client, () => !paused) }) });
    return { auto, library, sent, messages, client, release: () => release(), remove: () => { accounts = []; library.removeAccount(id); }, advance: () => { clock += 300001; } };
  };

  await test('关闭和暂停账号不发送，开启后每个账号独立防重', async () => {
    const disabled = harness('disabled', ['AUTO_DISABLED']);
    await disabled.auto.check(); assert.deepEqual(disabled.sent, []);
    disabled.library.setAuto('disabled', true);
    await disabled.auto.check(); await settled('disabled');
    assert.deepEqual(disabled.sent, ['AUTO_DISABLED']);
    disabled.advance(); await disabled.auto.check(); await settled('disabled');
    assert.deepEqual(disabled.sent, ['AUTO_DISABLED']); disabled.auto.close();
    const paused = harness('paused', ['AUTO_PAUSED'], { paused: true });
    paused.library.setAuto('paused', true); await paused.auto.check();
    assert.deepEqual(paused.sent, []); paused.auto.close();
  });

  await test('队列等待中关闭开关、关闭服务或删除账号，释放队列后均不发送', async () => {
    for (const action of ['disable', 'close', 'remove']) {
      const id = 'queued-' + action, run = harness(id, ['AUTO_' + action], { hold: true });
      run.library.setAuto(id, true); await run.auto.check();
      if (action === 'disable') run.library.setAuto(id, false);
      if (action === 'close') run.auto.close();
      if (action === 'remove') run.remove();
      run.release(); await settled(id);
      assert.deepEqual(run.sent, []);
      assert.equal(giftCodeStatus(id).rows[0].status, 'skipped');
      if (action === 'remove') assert.equal(run.library.auto(id).enabled, false);
      run.auto.close();
    }
  });

  await test('限频只停止本批，五分钟后自动续兑未发送的码', async () => {
    const id = 'rate-limit', run = harness(id, ['AUTO_LIMIT', 'AUTO_REST']);
    let refused = true;
    run.client.promptNames = { 1: 'GIFT_CODE_TOO_MANY_REQUESTS' };
    run.client.request = async (name, body) => {
      run.sent.push(body.giftCode);
      if (refused) { refused = false; throw Object.assign(Error(), { request: name, prompt: { prompt: 1 } }); }
      return { reward: { asset: [{ id: 'RUBY', num: 1 }] } };
    };
    run.library.setAuto(id, true); await run.auto.check(); await settled(id);
    assert.deepEqual(run.sent, ['AUTO_LIMIT']);
    await run.auto.check(); assert.deepEqual(run.sent, ['AUTO_LIMIT']);
    run.advance(); await run.auto.check(); await settled(id);
    assert.deepEqual(run.sent, ['AUTO_LIMIT', 'AUTO_LIMIT', 'AUTO_REST']); run.auto.close();
  });

  console.log(`礼包同步与自动兑换专项 ${passed}/${passed} 通过（假网络、假客户端、零游戏连接）`);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}
