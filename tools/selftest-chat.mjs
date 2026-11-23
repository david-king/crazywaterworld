import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-chat-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [0, 'SystemChatMsgCfg', { data: [{ id: '加入公会', notice: '欢迎[color=#fdb405][b]{1}[/b][/color]加入联盟', needCache: '是' }] }],
  [1, 'EmojiCfg', { data: [
    { id: 1001, name: '招手', groupId: 1, sortId: 2 },
    { id: 1004, name: '启航', icon: 'emoji_04', groupId: 4, sortId: 2 },
    { id: 1003, name: '收到', groupId: 4, sortId: 1 },
    { id: 1005, name: '启航', groupId: 3, sortId: 1 }, // Same name, different wire ID.
    { id: 1021, name: '新年好', groupId: 1, sortId: 1, actId: '新年好表情包', desc: '获取方式：春节签到' },
  ] }],
]));
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { exactAutomationId } = await import('../src/automation-policy.mjs');
const { iconEntry } = await import('../src/art.mjs');
const accounts = ['chat-a', 'chat-b'];
saveStore({ activeId: accounts[0], accounts: accounts.map(id => ({ id, label: id, url: 'ws://fixture.invalid',
  login: {}, automation: { enabled: false, autoStart: false } })) });
const app = createConsole({ port: 0, protocol: {} });
const base = await app.listen();
const api = async (account, channel, peer) => {
  const query = new URLSearchParams({ account, channel });
  if (peer) query.set('peer', peer);
  const response = await fetch(base + '/api/chat?' + query);
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
};
const sendApi = async (account, body) => {
  const response = await fetch(base + '/api/chat/send?account=' + encodeURIComponent(account), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
};
const peer = { playerId: '9007199254740993', nickname: '南风' };
const catalog = account => fetch(base + '/api/chat/emojis?account=' + account).then(r => r.json());
const newcomers = [1280, 320].map((width, index) => ({ playerId: (9007199254740996n + BigInt(index)).toString(), nickname: '海星' + width }));
const contacts = [peer, ...newcomers];
const record = { timestamp: 1730000000, side: 0, type: 1, message: '一起去太阳岛吗？' };
const msg = (text, time = 1730000000, sender = peer) => ({ sender, timestamp: time, content: { text, type: 1 } });
const system = { timestamp: 1730000000, content: { systemMsgId: '加入公会', systemMsgParams: ['南风'] } };
const live = (client, channel, message) => client.emit('message', { name: 'SCChatReceive', body: { channel, message } });
let browser;
try {
  await fetch(base + '/api/accounts').then(response => response.json());
  await assert.rejects(api(accounts[0], 'world'), /连接/);
  const calls = [];
  for (const id of accounts) {
    const session = app.sessions.get(id);
    session.player = { playerId: '9007199254740992', nickname: '船长', guildId: 1, worldId: 3 };
    const conversations = new Map([[peer.playerId, {peer, record}]]);
    const client = new EventEmitter();
    session.client = Object.assign(client, { connected: true, snapshot: () => ({ state: 'READY', connected: true }),
      stop() { this.connected = false; },
      protocol: { Prompt: { CONTAINS_FORBIDDEN_WORDS: 10, CHAT_CD: 6 } },
      async request(name, body, reply, timeout, beforeSend) {
        if (name === 'SendChatRequest' || name === 'PrivateChatSendRequest') {
          beforeSend();
          calls.push([id, name, body]);
          assert.equal(reply, 'OkResponse');
          const text = body.content?.text ?? body.message;
          const emoji = body.content?.attachment?.emoji ?? body.emoji;
          const received = emoji === 1005 ? 1004 : emoji;
          if (text === '拒绝消息') throw Object.assign(Error('server prompt'), { prompt: { prompt: 10 } });
          if (text === '结果未知') throw Error('timeout');
          if (name === 'SendChatRequest') {
            const message = msg(text, 1790000000, session.player);
            if (emoji) message.content = { type: 2, attachment: { emoji: received } };
            if (body.channel === 2) client.emit('message', { name: 'SCBatchChatReceive', body: { messages: [{ channel: 2, message }] } });
            else live(client, body.channel, message);
          }
          else {
            const recipient = contacts.find(p => p.playerId === exactAutomationId(body.peerPlayerId));
            assert(recipient);
            const chat = { peer: recipient, record: { side: 1, type: 1, message: text, timestamp: 1790000000 } };
            if (emoji) Object.assign(chat.record, { type: 2, emoji: received });
            conversations.set(recipient.playerId, chat);
            client.emit('message', { name: 'SCPrivateChatMessage', body: { record: chat } });
          }
          if (text === '仅回显' || emoji) throw Error('timeout');
          return {};
        }
        calls.push([id, name]);
        assert.equal(reply, name.replace(/Request$/, 'Response'));
        if (name === 'AllItemRequest') return { items: id === accounts[0] ? [{ itemId: '新年好表情包', num: 0 }] : [] };
        if (name === 'BlackListRequest') return { list: [{ playerId: 19 }] };
        if (name === 'OtherPlayerInfoRequest') {
          assert.equal(typeof body.playerId, 'string');
          const target = [...contacts, session.player].find(p => p.playerId === body.playerId);
          assert(target);
          return { nickname:target.nickname, playerLevel:38, power:{low:1,high:2097152}, worldId:3, guildIdx:1,
            topHero:[{heroId:'pilot',showName:'领航员',level:30,star:4}],pet:{petId:'海豹',level:9,star:2} };
        }
        if (name === 'PrivateChatListRequest') return { chats: [...conversations.values()] };
        if (name === 'PrivateChatRecordRequest') {
          if (newcomers.some(p => p.playerId === exactAutomationId(body.peerPlayerId))) return { records: [] };
          assert.equal(exactAutomationId(body.peerPlayerId), peer.playerId);
          return { peer, records: [record, { side: 1, type: 2, emoji: 1001, timestamp: 1730000001 }] };
        }
        assert.equal(name, 'ChatRecordRequest');
        if (body.channel === 2) return { message: [system, msg('集合地点在港口')] };
        assert.equal(body.channel, 1);
        const first = msg(id + ' 的历史消息');
        if (calls.filter(([who, what]) => who === id && what === name).length === 1) {
          live(client, 1, first); // Also present in the reply.
          live(client, 1, msg('历史载入期间收到', 1730000001));
        }
        return { message: [system, first, msg('已屏蔽的内容', 1730000001, { playerId: 19 })] };
      } });
  }
  const [first, second] = await Promise.all([api('chat-a', 'world'), api('chat-a', 'world')]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.rows.map(r => r.text), ['chat-a 的历史消息', '历史载入期间收到']);
  assert.equal(calls.filter(([, what]) => what === 'ChatRecordRequest').length, 1);
  assert.equal((await api('chat-a', 'system')).rows[0].text, '欢迎南风加入联盟');
  const session = app.sessions.get('chat-a'), client = session.client;
  assert.deepEqual((await api('chat-a', 'guild')).rows.map(r => r.system), [true, false]);
  session.player.guildId = 0;
  client.emit('message', { name: 'SCLeaveGuild', body: {} });
  assert.match((await api('chat-a', 'guild')).hint, /加入联盟/);
  session.player.guildId = 1;
  client.emit('message', { name: 'SCJoinGuild', body: {} });
  assert.equal(first.rows[0].senderId, peer.playerId);
  assert.equal((await api('chat-a', 'private')).rows[0].peerId, peer.playerId);
  const thread = await api('chat-a', 'private', peer.playerId);
  assert.deepEqual(thread.rows.map(r => [r.text, r.own]), [[record.message, false], ['［招手］', true]]);
  const privatePush = { side: 1, type: 1, message: '我在码头等你', timestamp: 1730000003 };
  client.emit('message', { name: 'SCPrivateChatMessage', body: { record: { peer, record: privatePush } } });
  assert.equal((await api('chat-a', 'private')).rows[0].text, privatePush.message);
  assert.equal((await api('chat-a', 'private', peer.playerId)).rows.at(-1).own, true);
  let result = await sendApi('chat-a', { confirm: true, channel: 'world', text: '世界频道问候' });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['chat-a', 'SendChatRequest']);
  assert.deepEqual(calls.at(-1)[2], { channel: 1, content: { type: 1, text: '世界频道问候', attachment: {} } });
  result = await sendApi('chat-a', { confirm: true, channel: 'private', peer: peer.playerId, text: '私聊问候' });
  assert.equal(result.status, 200);
  assert.equal(calls.at(-1)[1], 'PrivateChatSendRequest');
  assert.equal(exactAutomationId(calls.at(-1)[2].peerPlayerId), peer.playerId);
  result = await sendApi('chat-a', { confirm: true, channel: 'guild', text: '联盟集合' });
  assert.equal(result.status, 200);
  assert.equal(calls.at(-1)[2].channel, 2);
  result = await sendApi('chat-a', { confirm: true, channel: 'system', text: '不应发送' });
  assert.equal(result.status, 400);
  assert.match(result.value.error, /系统频道/);
  result = await sendApi('chat-a', { confirm: true, channel: 'world', text: '拒绝消息' });
  assert.equal(result.status, 400);
  assert.match(result.value.error, /限制的词语/);
  result = await sendApi('chat-a', { confirm: true, channel: 'world', text: '   ' });
  assert.equal(result.status, 400);
  assert.match(result.value.error, /不能为空/);
  assert.deepEqual((await sendApi('chat-a', { confirm: true, channel: 'world', text: '结果未知' })).value, { status: 'unknown' });
  assert.deepEqual((await sendApi('chat-a', { confirm: true, channel: 'world', text: '仅回显' })).value, { status: 'sent' });
  assert.equal((await sendApi('', { confirm: true, channel: 'world', text: '无账号' })).status, 400);
  assert.equal((await sendApi('chat-a', { channel: 'world', text: '未确认' })).status, 400);
  assert.equal((await sendApi('chat-a', { confirm: true, channel: 'world', text: '🚢'.repeat(76) })).status, 400);
  const sticker = (channel, emoji, extra) => sendApi('chat-a', { confirm: true, channel, emoji, ...extra });
  assert.deepEqual((await catalog('chat-a')).items.map(row => row.id), [1003, 1004, 1005, 1001]);
  const beforeInvalid = calls.length;
  for (const [channel, emoji, extra] of [['world', 999], ['world', '1004'], ['world', 1001, { text: '混合消息' }],
    ['system', 1001], ['private', 1001], ['guild', 1001, { peer: peer.playerId }], ['world', 1021]]) {
    assert.equal((await sticker(channel, emoji, extra)).status, 400);
  }
  assert.equal(calls.length, beforeInvalid);
  for (const [channel, wire] of [['world', 1], ['guild', 2]]) {
    await api('chat-a', channel);
    assert.deepEqual((await sticker(channel, 1004)).value, { status: 'sent' });
    assert.deepEqual(calls.at(-1), ['chat-a', 'SendChatRequest', { channel: wire, content: { type: 2, attachment: { emoji: 1004 } } }]);
    const row = (await api('chat-a', channel)).rows.at(-1);
    assert.equal(row.text, '［启航］');
    assert.equal(row.sticker, iconEntry('emoji_04')?.thumb || '');
  }
  assert.deepEqual((await sticker('private', 1004, { peer: peer.playerId })).value, { status: 'sent' });
  const privateBody = calls.at(-1)[2];
  assert.equal(exactAutomationId(privateBody.peerPlayerId), peer.playerId);
  assert.deepEqual({ ...privateBody, peerPlayerId: peer.playerId }, { type: 2, peerPlayerId: peer.playerId, message: '', emoji: 1004 });
  assert.equal((await api('chat-a', 'private')).rows[0].text, '［启航］');
  assert.equal((await api('chat-a', 'private', peer.playerId)).rows.at(-1).text, '［启航］');
  for (const channel of ['world', 'private']) {
    assert.deepEqual((await sticker(channel, 1005, channel === 'private' ? {peer:peer.playerId} : {})).value, { status:'unknown' });
  }
  const updateUnlock = num => client.emit('message', { name: 'SCUpdateItem', body: { items: [{ itemId: '新年好表情包', num }] } });
  updateUnlock(1);
  assert.deepEqual((await catalog('chat-a')).items.filter(row => row.special).map(row => row.id), [1021]);
  assert(!(await catalog('chat-b')).items.some(row => row.special));
  assert.equal((await sticker('world', 1021)).value.status, 'sent');
  const beforeGuildChange = calls.length;
  let restoreQueue;
  session.queueTail = new Promise(resolve => { restoreQueue = resolve; });
  const oldQueue = session.queueTail;
  const pendingSend = sendApi('chat-a', { confirm: true, channel: 'guild', text: '仅在原联盟发送' });
  const pendingEmoji = sticker('world', 1021);
  try {
    const deadline = Date.now() + 3000;
    while (session.queueTail === oldQueue && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(session.queueTail, oldQueue, '发送应进入当前账号队列');
    session.player.guildId = 2;
    updateUnlock(0);
  } finally {
    restoreQueue();
  }
  assert.equal((await pendingSend).status, 400);
  assert.equal((await pendingEmoji).status, 400);
  assert.equal(calls.length, beforeGuildChange);
  updateUnlock(1);
  client.emit('message', { name: 'SCBatchChatReceive', body: { messages: [1, 1, 2].map(channel => ({ channel, message: msg('同秒同文', 1730000005) })) } });
  assert.equal((await api('chat-a', 'world')).rows.filter(row => row.text === '同秒同文').length, 2);
  assert(!(await api('chat-b', 'world')).rows.some(row => row.text === '同秒同文'));
  await assert.rejects(api('chat-a', 'private', '9007199254740994'), /选择会话/);
  for (const newcomer of newcomers) live(client, 1, msg('刚到港口 ' + newcomer.nickname, 1780000000, newcomer));
  const profileUrl = base + '/api/chat/profile?peer=' + newcomers[0].playerId + '&account=';
  assert.equal((await fetch(profileUrl + 'chat-b')).status, 400);
  const profile = await fetch(profileUrl + 'chat-a').then(r => r.json());
  assert.equal(profile.nickname, newcomers[0].nickname);
  assert.equal(profile.power, '9007199254740993');
  assert.equal(profile.own, false);
  assert.equal(profile.heroes[0].name, '领航员');
  assert.equal(profile.pet.name, '海豹');
  assert.deepEqual((await api('chat-a', 'private', newcomers[0].playerId)).rows, []);
  assert(!(await api('chat-a', 'private')).rows.some(row => row.peerId === newcomers[0].playerId));
  console.log('聊天记录、三频道文字与表情收发、解锁道具、回显确认和账号隔离通过');

  if (process.argv.includes('--browser')) {
    const { chromium } = await import('playwright-core');
    const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
      'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(file => fs.existsSync(file));
    browser = await chromium.launch({ executablePath, headless: true });
    for (const width of [1280, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const chatRequests = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/chat') || url.pathname.startsWith('/ui/chunks/chat-'))
          chatRequests.push(url);
      });
      await page.goto(base);
      await page.locator('#tabs [data-tab="overview"][aria-current="page"]').waitFor();
      await page.locator('#tabs [data-tab="resources"]').click();
      await page.locator('[data-resource-tab="guild"][aria-current="page"]').waitFor();
      assert.deepEqual(chatRequests, []);
      await page.locator('[data-resource-tab="chat"]').click();
      const pane = page.locator('#chat-root');
      const chooseWorld = () => pane.getByRole('button', { name: '世界', exact: true }).click();
      await pane.getByText('请选择频道查看聊天记录。').waitFor();
      assert(chatRequests.some(url => url.pathname.startsWith('/ui/chunks/chat-')));
      assert(!chatRequests.some(url => url.pathname.startsWith('/api/chat')));
      await chooseWorld();
      await pane.getByText('chat-a 的历史消息').waitFor();
      assert(chatRequests.filter(url => url.pathname === '/api/chat').every(url => url.searchParams.get('channel') === 'world'));
      const input = pane.getByLabel('聊天消息');
      const openEmojis = pane.getByRole('button', { name: '选择表情' });
      await input.fill('未发出的草稿');
      await openEmojis.click();
      const picker = pane.getByRole('dialog', { name: '选择表情' });
      const sendSticker = picker.getByRole('button', { name: '发送表情：启航' });
      async function pickSticker(button) {
        const response = page.waitForResponse(r => r.url().includes('/api/chat/send?') && r.request().method() === 'POST');
        await button.click();
        assert.deepEqual(await (await response).json(), { status: 'sent' });
        await picker.waitFor({ state: 'hidden' });
      }
      await sendSticker.waitFor();
      assert.equal(await picker.getByRole('button', { name: '第 4 组' }).getAttribute('aria-pressed'), 'true');
      if (iconEntry('emoji_04')) await sendSticker.locator('img').evaluate(img => img.decode());
      await picker.getByRole('button', { name: '第 1 组' }).click();
      const special = picker.getByRole('button', { name: '发送表情：新年好' });
      assert(await special.getAttribute('data-unread'));
      await pickSticker(special);
      assert.equal(calls.filter(([, what]) => what === 'SendChatRequest').at(-1)[2].content.attachment.emoji, 1021);
      assert.equal(await input.inputValue(), '未发出的草稿');
      await openEmojis.click();
      await sendSticker.waitFor();
      assert.equal(await picker.getByRole('button', { name: '第 1 组' }).getAttribute('data-unread'), null);
      await pickSticker(sendSticker);
      if (iconEntry('emoji_04')) await pane.getByRole('img', { name: '［启航］' }).last().evaluate(img => img.decode());
      const target = newcomers.find(player => player.nickname === '海星' + width);
      await pane.getByRole('button', {name:'查看' + target.nickname + '的资料', exact:true}).click();
      const dialog = pane.getByRole('dialog', {name:target.nickname});
      await dialog.getByText('9,007,199,254,740,993').waitFor();
      await dialog.getByText('领航员').waitFor();
      await dialog.getByRole('button',{name:'私聊',exact:true}).click();
      await pane.getByPlaceholder('发给 ' + target.nickname).fill('第一次联系 ' + width);
      await input.press('Enter');
      await pane.getByText('第一次联系 ' + width, {exact:true}).waitFor();
      assert.equal(exactAutomationId(calls.filter(([, what]) => what === 'PrivateChatSendRequest').at(-1)[2].peerPlayerId), target.playerId);
      await pane.getByRole('button',{name:'会话列表'}).click();
      await pane.getByRole('button',{name:new RegExp(target.nickname + '.*第一次联系')}).click();
      await pane.getByText('第一次联系 ' + width, {exact:true}).waitFor();
      await pane.getByRole('button',{name:'世界',exact:true}).click();
      const sentText = '浏览器发送 ' + width;
      await input.fill(sentText);
      await pane.getByRole('button', { name: '发送', exact: true }).click();
      await pane.getByText(sentText, { exact: true }).waitFor();
      await pane.getByRole('button', {name:'查看船长的资料'}).first().click();
      const ownCard = pane.getByRole('dialog', {name:'船长'});
      await ownCard.getByText('领航员').waitFor();
      assert.equal(await ownCard.getByRole('button', {name:'私聊'}).count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await input.inputValue(), '');
      await input.fill('拒绝消息');
      await input.press('Enter');
      await pane.getByRole('alert').filter({ hasText: '限制的词语' }).waitFor();
      assert.equal(await input.inputValue(), '拒绝消息');
      const payload = '新消息 <b>' + width + '</b>';
      live(client, 1, msg(payload, 1730000009));
      await pane.getByText(payload, { exact: true }).waitFor();
      await pane.getByRole('button', { name: '系统', exact: true }).click();
      await pane.getByText('欢迎南风加入联盟').waitFor();
      const notice = pane.getByRole('article', { name: '系统公告' }).first();
      assert.equal(await notice.locator('[data-bold]').textContent(), '南风');
      assert(await notice.locator('[data-bold]').evaluate(el => getComputedStyle(el).color !== getComputedStyle(el.parentElement).color));
      assert.match(await notice.locator('time').textContent(), /\d\d:\d\d:\d\d/);
      assert.equal(await input.count(), 0);
      assert.equal(await openEmojis.count(), 0);
      await pane.getByRole('button', { name: '私聊', exact: true }).click();
      await pane.getByRole('button', { name: /^南风/ }).click();
      await pane.getByText(record.message).waitFor();
      await pane.getByText('［招手］').waitFor();
      assert.equal(await input.inputValue(), '');
      await openEmojis.click();
      await pickSticker(sendSticker);
      const lastPrivate = calls.filter(([, what]) => what === 'PrivateChatSendRequest').at(-1)[2];
      assert.equal(lastPrivate.emoji, 1004);
      assert.equal(exactAutomationId(lastPrivate.peerPlayerId), peer.playerId);
      const reply = '私聊回复 ' + width;
      await input.fill(reply);
      await input.press('Enter');
      await pane.getByText(reply, { exact: true }).waitFor();
      await pane.getByRole('button', { name: '会话列表' }).click();
      await pane.getByRole('button', { name: /^南风/ }).waitFor();
      await pane.getByRole('button', { name: '联盟', exact: true }).click();
      await pane.getByText('集合地点在港口').waitFor();
      await openEmojis.click();
      await pickSticker(sendSticker);
      assert.deepEqual(calls.filter(([, what]) => what === 'SendChatRequest').at(-1)[2], { channel: 2, content: { type: 2, attachment: { emoji: 1004 } } });
      const guildText = '联盟回复 ' + width;
      await input.fill(guildText);
      await input.press('Enter');
      await pane.getByText(guildText, { exact: true }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#account-picker-trigger').click();
      await page.getByRole('option', { name: /chat-b/ }).click();
      await pane.getByText('请选择频道查看聊天记录。').waitFor();
      await chooseWorld();
      await pane.getByText('chat-b 的历史消息').waitFor();
      assert.equal(await pane.getByText(payload).count(), 0);
      await page.locator('#account-picker-trigger').click();
      await page.getByRole('option', { name: /chat-a/ }).click();
      await pane.getByText('请选择频道查看聊天记录。').waitFor();
      await chooseWorld();
      await pane.getByText('chat-a 的历史消息').waitFor();
      await page.locator('[data-resource-tab="giftcodes"]').click();
      await input.waitFor({state:'detached'});
      const previousReads = chatRequests.length;
      await page.evaluate(() => window.dispatchEvent(new Event('cw-chat-update')));
      await page.locator('[data-resource-tab="chat"]').click();
      await pane.getByText('请选择频道查看聊天记录。').waitFor();
      assert.equal(chatRequests.length, previousReads);
      assert.deepEqual(errors, []);
      await page.close();
    }
    for (let i = 0; i < 75; i++) live(client, 1, msg('靠港记录 ' + i, 1800000000 + i));
    for (const [width,height] of [[320,568],[390,844],[768,600]]) {
      const page = await browser.newPage({ viewport:{ width,height }, isMobile: true, hasTouch: true });
      await page.addInitScript(() => history.replaceState({ consoleView: { tab: 'chat' } }, ''));
      await page.goto(base);
      const pane = page.locator('#chat-root');
      await page.locator('[data-resource-tab="chat"][aria-current="page"]').waitFor();
      assert.deepEqual(await page.evaluate(() => history.state.consoleView), { tab: 'resources', resource: 'chat' });
      await pane.getByRole('button', { name: '世界', exact: true }).click();
      await pane.getByLabel('聊天消息').waitFor();
      await pane.getByRole('button', {name:'选择表情'}).click();
      const picker = pane.getByRole('dialog', {name:'选择表情'});
      const tile = picker.getByRole('button', {name:'发送表情：启航'});
      await tile.waitFor();
      const tileBox = await tile.boundingBox();
      assert(tileBox.width >= 44 && tileBox.height >= 44);
      if (iconEntry('emoji_04')) {
        const image = await tile.locator('img').boundingBox();
        assert(image.width >= 44 && image.height >= 44);
      }
      await page.keyboard.press('Escape');
      await picker.waitFor({state:'hidden'});
      assert.equal(await pane.getByRole('heading', { name:'聊天' }).count(), 0);
      const feed = pane.locator('[data-transcript="true"]');
      const layout = await feed.evaluate(el => {
        const nav = document.querySelector('#tabs').getBoundingClientRect();
        const form = document.querySelector('#chat-root form').getBoundingClientRect();
        return { height: document.documentElement.scrollHeight, y:window.scrollY, viewport:innerHeight,
          feedTop:el.scrollTop, scrollable:el.scrollHeight > el.clientHeight, bottom:form.bottom, navTop:nav.top };
      });
      assert(layout.height <= layout.viewport + 1 && layout.y === 0 && layout.feedTop === 0 && layout.scrollable && layout.bottom <= layout.navTop, JSON.stringify(layout));
      const mark = await feed.evaluate(el => {
        el.scrollTop = -400;
        const box = el.getBoundingClientRect();
        const row = [...el.querySelectorAll('article')].find(row => row.getBoundingClientRect().top >= box.top);
        return { text:row.textContent, y:row.getBoundingClientRect().top };
      });
      const incoming = '靠港更新 ' + width;
      live(client, 1, msg(incoming, 1800001000 + width));
      await pane.getByText(incoming, {exact:true}).waitFor({state:'attached'});
      const y = await feed.evaluate((el, text) => [...el.querySelectorAll('article')].find(row => row.textContent === text).getBoundingClientRect().top, mark.text);
      assert(Math.abs(y - mark.y) < 2, '收到推送时阅读位置改变 ' + (y - mark.y));
      await page.close();
    }
    console.log('桌面与手机端表情选择、三频道发送、草稿与红点、聊天公告和阅读位置通过');
  }
  if (process.argv.includes('--preview')) {
    console.log('本地聊天模拟预览：' + base);
    await new Promise(resolve => process.once('SIGINT', resolve));
  }
} finally {
  await browser?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
