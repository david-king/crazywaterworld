import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-protocol-v77-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
try {
  const { loadProtocol } = await import('../src/proto.mjs');
  const { BUNDLED_PROTOCOL } = await import('../src/protocol-source.mjs');
  const { createCodec } = await import('../src/codec.mjs');
  const { GameClient } = await import('../src/client.mjs');
  const { createGameChat } = await import('../src/chat.mjs');
  const { collectState, ENTRY_QUERIES } = await import('../src/game.mjs');
  const { readWorldListPlayers } = await import('../src/player-name-history.mjs');
  // Always exercise the shipped bundle, including when the offline runner points
  // CW_PROTO_BUNDLE at a missing path. No installed game or account is required.
  const protocol = loadProtocol(BUNDLED_PROTOCOL);
  assert.equal(typeof protocol.ChatChannel.encode, 'function');
  const legacy = { ...createDeclaredProtocol([
    'ChatRecordRequest', 'ChatRecordResponse', 'SendChatRequest', 'OkResponse',
    'SCChatReceive', 'SCBatchChatReceive', 'BlackListRequest', 'BlackListResponse',
    'RankRequest', 'RankResponse', 'WorldInfoRequest', 'WorldInfoResponse',
    'PrivateChatListRequest', 'PrivateChatListResponse',
  ]), ChatChannel: { CHAT_WORLD: 1, CHAT_GUILD: 2 } };
  const player = { playerId: '9007199254740992', nickname: '离线船长', guildId: 1 };
  const peer = { playerId: '9007199254740993', nickname: '离线伙伴' };
  const message = (text, sender = peer) => ({ sender, timestamp: 1730000000, content: { type: 1, text } });
  const config = { tables: { EmojiCfg: { data: [{ id: 1001, name: '招手' }] } } };
  const current = () => {}, schedule = work => work();

  for (const [label, p, structured] of [['v77', protocol, true], ['legacy fixture', legacy, false]]) {
    const codec = structured ? createCodec(p) : null;
    const wire = (name, body) => codec ? codec.decode(codec.encode(name, 1, body)).body : p[name].decode(p[name].encode(body).finish());
    const channel = type => structured ? { type } : type;
    const client = new EventEmitter();
    const calls = [], updates = [];
    const push = (name, body) => client.emit('message', { name, body: wire(name, body) });
    Object.assign(client, { protocol: p, connected: true,
      async request(name, body, responseName, _timeout, beforeSend) {
        beforeSend?.();
        calls.push({ name, body });
        const decoded = wire(name, body);
        let response = {};
        if (name === 'ChatRecordRequest' || name === 'SendChatRequest') {
          const type = structured ? decoded.channel.type : decoded.channel;
          assert([1, 2].includes(type), label + ' must encode a valid public channel');
          assert.deepEqual(body.channel, channel(type));
          if (name === 'ChatRecordRequest') {
            response.message = [message('频道 ' + type + ' 历史')];
          } else {
            const content = decoded.content;
            if (content.text !== '无回执') {
              const echoType = content.text === '错误频道' ? 3 : type;
              push('SCBatchChatReceive', { messages: [{ channel: channel(echoType), message: { ...message('', player), content } }] });
            }
            throw Error('模拟确认超时，依据回显判断结果');
          }
        } else if (name === 'BlackListRequest') response.list = [];
        else if (name === 'RankRequest') response = { rankData: [], maxPage: 1 };
        else if (name === 'WorldInfoRequest') response.fleets = [];
        else if (name === 'PrivateChatListRequest') response.chats = [];
        else assert.fail('unexpected request ' + name);
        return wire(responseName, response);
      },
    });
    const chat = createGameChat(client, { player: { ...player }, config, changed: keys => updates.push(...keys) });
    for (const [name, type] of [['world', 1], ['guild', 2]]) {
      assert.equal((await chat.read(name, null, schedule, current)).rows[0].text, '频道 ' + type + ' 历史');
      push('SCChatReceive', { channel: channel(type), message: message('实时 ' + name) });
      assert.equal((await chat.read(name, null, schedule, current)).rows.at(-1).text, '实时 ' + name);
      assert.equal((await chat.send({ channel: name, text: '回显 ' + name }, schedule, current)).status, 'sent');
      assert.equal((await chat.send({ channel: name, emoji: 1001 }, schedule, current)).status, 'sent');
    }
    assert(updates.includes('world') && updates.includes('guild'));
    assert.equal((await chat.send({ channel: 'world', text: '无回执' }, schedule, current)).status, 'unknown');
    assert.equal((await chat.send({ channel: 'world', text: '错误频道' }, schedule, current)).status, 'unknown');
    assert(!(await chat.read('world', null, schedule, current)).rows.some(row => row.text === '错误频道'));
    const entryQuery = ENTRY_QUERIES.find(row => row.name === 'ChatRecordRequest');
    const snapshot = await collectState(client, p, { queries: [entryQuery], signals: [] });
    assert.deepEqual(snapshot.failed, {});
    assert.equal(snapshot.ok.ChatRecordRequest.message[0].content.text, '频道 1 历史');
    const world = await readWorldListPlayers(client, player, current, 1);
    assert.equal(world.reason, '');
    assert.equal(world.members.find(row => row.id === peer.playerId).name, peer.nickname);
    assert.deepEqual(calls.filter(row => row.name === 'ChatRecordRequest').at(-1).body.channel, channel(1));
    console.log(label + '：聊天历史、单双推送、文字/表情回显、错误频道隔离、登录查询与玩家名单通过');
  }
  assert.deepEqual(ENTRY_QUERIES.find(row => row.name === 'ChatRecordRequest').body, { channel: { type: 1 } }, 'legacy connection must not mutate shared entry queries');

  // A NO_GUILD prompt must reject the guild send, even with a world send pending.
  const client = new GameClient({ protocol });
  const frames = [];
  client.socket = { readyState: 1, send: frame => frames.push(client.codec.decode(frame)) };
  const world = client.request('SendChatRequest', { channel: { type: 1 }, content: { text: '世界' } }, 'OkResponse').catch(error => error);
  const guild = client.request('SendChatRequest', { channel: { type: 2 }, content: { text: '联盟' } }, 'OkResponse').catch(error => error);
  try {
    assert.equal(frames[1].body.channel.type, 2);
    client.attributePrompt({ prompt: protocol.Prompt.NO_GUILD });
    assert.equal((await guild).request, 'SendChatRequest');
    assert.equal(client.pending.length, 1);
    assert(!client.pending[0].requiresGuild);
  } finally {
    client.releaseRequests('测试结束');
    await world;
    await guild;
    client.socket = null;
  }

  const round = (name, body) => protocol[name].decode(protocol[name].encode(body).finish());
  const supply = round('SCUpdateSupply', { supply: [
    { uid: '9007199254740993', supId: '测试补给一', shapeId: 1 },
    { uid: '9007199254740995', supId: '测试补给二', shapeId: 2, lock: true },
  ] });
  assert.equal(supply.supply.length, 2);
  assert.equal(String(supply.supply[1].uid), '9007199254740995');
  assert.equal(supply.supply[1].lock, true);
  assert.deepEqual(round('SupplyBatchComposeRequest', { level: 1, retain: [1, 3] }).retain, [1, 3]);
  assert.deepEqual(round('VipInfo', { cumRechargeStage: [2, 4] }).cumRechargeStage, [2, 4]);
  for (const name of ['HomelandRequest', 'DualCombineInfoRequest', 'GroupChatListRequest']) round(name, {});
  assert.equal(protocol.SpringInfoRequest, undefined);
  assert.equal(protocol.EquinoxInfoRequest, undefined);
  assert.equal(protocol.SupplyCustomOpenRequest, undefined);
  console.log('v77 内置协议：联盟错误归属、批量补给/锁定/保留属性、累充字段及新旧消息通过');
} finally {
  const target = fs.realpathSync(directory);
  assert.equal(path.dirname(target), temporary);
  assert(path.basename(target).startsWith('cw-protocol-v77-'));
  fs.rmSync(target, { recursive: true, force: true });
}
