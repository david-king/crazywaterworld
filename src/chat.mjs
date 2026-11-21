import { exactAutomationId, automationWireId } from './automation-policy.mjs';
import { iconEntry } from './art.mjs';
import { toNumber } from './client.mjs';
import { createGuildNameResolver } from './guild-name.mjs';

const LIMIT = 100; // 游戏每个频道保留最近 100 条。
const channels = new Set(['world', 'system', 'private', 'guild']);

function systemText(content, config, player, protocol, guildName) {
  const id = content.systemMsgId;
  const find = (table, field, value) => config?.tables?.[table]?.data?.find(row => String(row[field]) === String(value));
  const template = find('SystemChatMsgCfg', 'id', id)?.notice;
  const params = [...(content.systemMsgParams ?? [])];
  if (!template) return { text: content.text || [id, ...params].join(' · ') };
  const city = value => find((player.scenarioId || 1) + '_CityCfg', 'id', value)?.name || value;
  const guild = value => Number(value) ? guildName(Number(value)).name || String(value) : 'NPC';
  const title = value => find('GuildTitleCfg', 'title', protocol?.GuildMemberTitle?.[value] ?? value)?.name || value;
  const ship = (quality, index) => find('TreasureLootCfg', 'quality', quality)?.name || ('货轮 ' + index);
  const [a, b, c, d] = params;
  let values = params;
  switch (id) {
    case '招募英雄': case '招募红英雄': {
      const hero = find('HeroCfg', 'id', c);
      const quality = find('ColorViewCfg', 'quality', b)?.title || b;
      values = [a, quality + (hero?.quality === 'ORANGE' && hero.qualityGrade === 2 ? '+' : ''), hero?.name || c];
      break;
    }
    case '实物奖励': values = [a, find('ItemCfg', 'id', b)?.show_name || b]; break;
    case '宣战成功': case '取消宣战': values = [guild(a), title(b), c, city(d)]; break;
    case '城池易帜': values = [b, guild(c), city(a)]; break;
    case '系统宣战': values = [guild(a), city(b)]; break;
    case '职位变更': values = [a, title(b)]; break;
    case '集结': case '国战连杀': values = [a, city(b), c]; break;
    case '橙宝藏易主': values = [guild(a), ship(c, b)]; break;
    case '盟友占领宝藏': values = [a, ship(c, b)]; break;
    case '宝藏连杀': values = [a, ship(b, c), d]; break;
    case '工事损毁': values = [city(a), find('WorldFortCfg', 'fortId', b)?.name || b]; break;
    case '工事发起建造': case '工事完成建造': case '工事拆除':
      values = [a, city(b), find('WorldFortCfg', 'fortId', c)?.name || c]; break;
    case '尾刀BOSS出现': values = [find('LimitedBossCfg', 'bossId', a)?.bossName || a]; break;
    case '尾刀BOSS击杀': values = [a, find('LimitedBossCfg', 'bossId', b)?.bossName || b]; break;
    case '联盟商船船长': {
      const quality = find('GuildShipCfg', 'shipId', protocol?.GuildShipType?.[b] ?? b)?.quality;
      values = [a, find('ColorViewCfg', 'quality', quality)?.title || b]; break;
    }
  }
  // Interpret markup only in game templates. Names and other values are literal text.
  const parts = [];
  let color = '', bold = false;
  for (const token of template.split(/(\[color=#[\da-f]{3,8}\]|\[\/color\]|\[b\]|\[\/b\])/gi)) {
    if (!token) continue;
    if (token.startsWith('[color=')) color = token.slice(7, -1);
    else if (token === '[/color]') color = '';
    else if (token === '[b]' || token === '[/b]') bold = token === '[b]';
    else parts.push({ text: token.replace(/\{(\d+)\}/g, (_, n) => values[Number(n) - 1] ?? '未知'), color, bold });
  }
  return { text: parts.map(part => part.text).join(''), parts };
}

// A connection owns its history, including pushes arriving during the initial read.
// The game has no message ID. Match history/push overlap by occurrence count so
// two equal messages from one player in the same second can both survive.
function mergeHistory(history, pushes) {
  const counts = new Map();
  for (const row of history) counts.set(row.signature, (counts.get(row.signature) || 0) + 1);
  return history.concat(pushes.filter(row => {
    const count = counts.get(row.signature) || 0;
    if (count) counts.set(row.signature, count - 1);
    return !count;
  }));
}

function latest(rows, conversations) {
  rows.sort((a, b) => a.time - b.time);
  if (!conversations) return rows.slice(-LIMIT);
  return [...new Map(rows.map(row => [row.peerId, row])).values()].sort((a, b) => b.time - a.time);
}

export function createGameChat(client, { player, config, changed }) {
  const feeds = new Map();
  const ownId = exactAutomationId(player.playerId);
  const emojiRows = (config?.tables?.EmojiCfg?.data ?? [])
    .map(row => ({ ...row, groupId: row.groupId ?? 1, sortId: row.sortId ?? 0 }))
    .sort((a, b) => b.groupId - a.groupId || a.sortId - b.sortId);
  const emojiById = new Map(emojiRows.map(row => [row.id, row]));
  const unlockItems = new Set(emojiRows.map(row => row.actId).filter(Boolean));
  let ownedItems = null;
  function updateUnlocks(items, full) {
    if (!Array.isArray(items) || !unlockItems.size || (!full && !ownedItems)) return;
    const owned = full ? new Set() : new Set(ownedItems);
    for (const { itemId, num } of items) {
      if (!unlockItems.has(itemId)) continue;
      if (toNumber(num) > 0) owned.add(itemId);
      else owned.delete(itemId);
    }
    const previous = ownedItems;
    ownedItems = owned;
    if (previous && (owned.size !== previous.size || [...owned].some(id => !previous.has(id)))) changed(['emojis']);
  }
  async function loadUnlocks(current) {
    current();
    if (!unlockItems.size || ownedItems) return;
    const bag = await client.request('AllItemRequest', {}, 'AllItemResponse', 8000, current);
    current();
    // GameClient publishes the reply before resolving the request. Preserve any newer push.
    if (!ownedItems) updateUnlocks(bag?.items, true);
    if (!ownedItems) throw Error('无法读取活动表情解锁状态');
  }
  async function emojis(schedule, current) {
    let hint = '';
    if (!emojiRows.length) hint = '暂无表情配置';
    if (unlockItems.size && !ownedItems) {
      try { await schedule(() => loadUnlocks(current)); }
      catch { hint = '活动表情解锁状态读取失败'; }
    }
    current();
    const groups = [...new Set(emojiRows.map(row => row.groupId))].map(id => ({ id, icon: iconEntry('ui_chat/emoji-group-' + id)?.thumb || '' }));
    return { owner: ownId || '', hint, groups, items: emojiRows.filter(row => !row.actId || ownedItems?.has(row.actId))
      .map(row => ({ id: row.id, name: row.name, group: row.groupId, special: Boolean(row.actId),
        sticker: iconEntry(row.icon)?.thumb || '' })) };
  }
  let guildName = createGuildNameResolver(config, player.scenarioId);
  let blocked, sequence = 0;
  function avatarUrl(avatar) {
    const head = avatar?.image && config?.tables?.HeadImageCfg?.data?.find(row => row.id === avatar.image);
    return iconEntry(head?.icon)?.thumb || '';
  }
  function media(type, message, emoji) {
    if (type === 2) {
      const item = emojiById.get(emoji);
      return { text: item ? '［' + item.name + '］' : '［表情］', emoji };
    }
    return { text: message || (type === 3 ? '［语音］' : '［消息］'), sticker: '' };
  }
  function makeRow({ senderId, sender, time, content, own, system = false, peerId = '', avatar }) {
    const signature = JSON.stringify([senderId, time, content, system, peerId, own]);
    return { sender, time: time || 0, ...content, own, system, peerId, avatar: avatarUrl(avatar),
      senderId, signature, id: ++sequence };
  }
  function publicRow(message) {
    const content = message?.content;
    if (!content) return null;
    const system = Boolean(content.systemMsgId), senderId = exactAutomationId(message.sender?.playerId);
    return makeRow({ senderId, sender: system ? '系统' : message.sender?.nickname || '未知玩家',
      time: message.timestamp, own: Boolean(senderId && senderId === ownId), system, avatar: message.sender?.avatar,
      content: system ? { ...systemText(content, config, player, client.protocol, guildName), sticker: '' }
        : media(content.type, content.text, content.attachment?.emoji) });
  }
  function privateRow(peer, record, conversation) {
    const peerId = exactAutomationId(peer?.playerId);
    if (!peerId || !record) return null;
    const own = record.side === 1, name = peer.nickname || peerId;
    const showPeer = conversation || !own;
    return makeRow({ senderId: own ? ownId : peerId, sender: showPeer ? name : player.nickname || '我',
      time: record.timestamp, content: media(record.type, record.message, record.emoji), own, peerId,
      avatar: showPeer ? peer.avatar : player.avatar });
  }
  function append(key, row, dirty) {
    const feed = feeds.get(key);
    if (!feed || !row) return;
    feed.rows = latest([...feed.rows, row], key === 'private');
    dirty.add(key);
  }
  client.on('message', ({ name, body }) => {
    if (name === 'AllItemResponse' || name === 'SCUpdateItem') {
      updateUnlocks(body.items, name === 'AllItemResponse');
      return;
    }
    if (name === 'AllGuildAbstractionResponse') {
      guildName = createGuildNameResolver(config, player.scenarioId, body.guilds);
      return;
    }
    if (name === 'BlackListResponse') {
      blocked = new Set((body.list ?? []).map(row => exactAutomationId(row.playerId)).filter(Boolean));
      return;
    }
    if (name === 'SCJoinGuild' || name === 'SCLeaveGuild') {
      feeds.delete('guild');
      changed(['guild']);
      return;
    }
    const dirty = new Set();
    if (name === 'SCPrivateChatMessage') {
      const chat = body.record;
      const id = exactAutomationId(chat?.peer?.playerId);
      if (!id) return;
      append('private', privateRow(chat.peer, chat.record, true), dirty);
      append('private/' + id, privateRow(chat.peer, chat.record, false), dirty);
    } else if (name === 'SCChatReceive' || name === 'SCBatchChatReceive') {
      for (const { channel, message } of name === 'SCChatReceive' ? [body] : body.messages ?? []) {
        if (channel !== 1 && channel !== 2) continue;
        const system = message?.content?.systemMsgId;
        const key = channel === 2 ? 'guild' : system ? 'system' : 'world';
        if (!feeds.has(key)) continue;
        if (system && config?.tables?.SystemChatMsgCfg?.data?.find(row => row.id === system)?.needCache === '否') continue;
        append(key, publicRow(message), dirty);
      }
    }
    if (dirty.size) changed([...dirty]);
  });

  function knownPlayer(id) {
    if (!id || id !== exactAutomationId(id)) return null;
    if (id === ownId) return { name: player.nickname || '我' };
    const preview = feeds.get('private')?.rows.find(row => row.peerId === id);
    if (preview) return { name: preview.sender };
    for (const [key, feed] of feeds) {
      if (key === 'private' || (blocked?.has(id) && !key.startsWith('private/'))) continue;
      const row = feed.rows.find(row => !row.system && row.senderId === id);
      if (row) return { name: row.sender };
    }
    return null;
  }
  async function profile(id, schedule, current) {
    const target = knownPlayer(id);
    if (!target) throw Error('请选择当前账号聊天中的玩家');
    return schedule(async () => {
      current();
      const info = await client.request('OtherPlayerInfoRequest', { playerId: id }, 'OtherPlayerInfoResponse', 8000);
      current();
      const configName = (table, key, value) => config?.tables?.[table]?.data?.find(row => row[key] === value)?.name;
      const sameWorld = exactAutomationId(info.worldId) && exactAutomationId(info.worldId) === exactAutomationId(player.worldId);
      return { id, own: id === ownId, nickname: info.nickname || target.name, avatar: avatarUrl(info.avatar),
        level: info.playerLevel ?? 0, power: exactAutomationId(info.power) || '0',
        guild: sameWorld && info.guildIdx > 0 ? guildName(info.guildIdx).name || '联盟 ' + info.guildIdx : '',
        title: info.title > 3000 ? configName('TitleCfg', 'id', info.title) || '' : '',
        heroes: (info.topHero ?? []).map(hero => ({ id: hero.heroId, name: hero.showName || configName('HeroCfg', 'id', hero.heroId) || hero.heroId,
          level: hero.level || 0, star: hero.star || 0 })),
        pet: info.pet?.petId ? { id: info.pet.petId, name: configName('PetBaseCfg', 'petId', info.pet.petId) || info.pet.petId,
          level: info.pet.level || 0, star: info.pet.star || 0 } : null };
    });
  }
  async function history(channel, peerId, current) {
    if (peerId) {
      const target = knownPlayer(peerId);
      if (!target || peerId === ownId) throw Error('请从聊天玩家或私聊列表选择会话');
      const reply = await client.request('PrivateChatRecordRequest', { peerPlayerId: automationWireId(peerId) }, 'PrivateChatRecordResponse');
      if (reply.peer && exactAutomationId(reply.peer.playerId) !== peerId) throw Error('服务器返回了其他私聊会话');
      const peer = reply.peer ?? { playerId: peerId, nickname: target.name };
      return (reply.records ?? []).map(record => privateRow(peer, record, false));
    }
    if (channel === 'private') {
      const reply = await client.request('PrivateChatListRequest', {}, 'PrivateChatListResponse');
      return (reply.chats ?? []).map(chat => privateRow(chat.peer, chat.record, true));
    }
    if (!blocked) {
      const reply = await client.request('BlackListRequest', {}, 'BlackListResponse');
      blocked = new Set((reply.list ?? []).map(row => exactAutomationId(row.playerId)).filter(Boolean));
      current();
    }
    const reply = await client.request('ChatRecordRequest', { channel: channel === 'guild' ? 2 : 1 }, 'ChatRecordResponse');
    return (reply.message ?? []).filter(message => channel === 'guild' || Boolean(message.content?.systemMsgId) === (channel === 'system')).map(publicRow);
  }

  async function read(channel, peerId, schedule, current) {
    if (!channels.has(channel) || (peerId && (channel !== 'private' || !exactAutomationId(peerId)))) throw Error('聊天频道或会话无效');
    const key = peerId ? 'private/' + peerId : channel;
    current();
    if (key === 'guild' && !exactAutomationId(player.guildId)) return { rows: [], hint: '加入联盟后可查看联盟聊天。' };
    let feed = feeds.get(key);
    if (!feed) {
      feed = { rows: [] };
      feeds.set(key, feed);
      // Keep only a handful of opened private histories. Their previews stay in the list.
      const threads = [...feeds.keys()].filter(item => item.startsWith('private/'));
      if (threads.length > 12) feeds.delete(threads[0]);
      feed.ready = schedule(async () => {
        current();
        const rows = await history(channel, peerId, current);
        current();
        feed.rows = latest(mergeHistory(rows.filter(Boolean), feed.rows), key === 'private');
      }).catch(error => {
        if (feeds.get(key) === feed) feeds.delete(key);
        throw error;
      });
    }
    await feed.ready;
    current();
    if (feeds.get(key) !== feed) throw Error('聊天会话已变化，请重新读取');
    const rows = feed.rows.filter(row => channel === 'private' || !blocked?.has(row.senderId))
      .map(({ signature, emoji, ...row }) => emoji == null ? row
        : { ...row, sticker: iconEntry(emojiById.get(emoji)?.icon)?.thumb || '' });
    return { rows, hint: '' };
  }
  async function send({ channel, peer, text, emoji }, schedule, current) {
    if (channel === 'system') throw Error('系统频道只显示公告');
    if (!['world', 'guild', 'private'].includes(channel)) throw Error('聊天频道无效');
    const isEmoji = emoji !== undefined, type = isEmoji ? 2 : 1;
    const item = emojiById.get(emoji);
    if (isEmoji) {
      if (text !== undefined) throw Error('文字和表情需分开发送');
      if (!Number.isSafeInteger(emoji) || !item) throw Error('请选择游戏表情');
    } else {
      if (typeof text !== 'string' || !text.trim()) throw Error('消息不能为空');
      if (text.length > 150) throw Error('消息不能超过 150 个字');
    }
    const privateChat = channel === 'private';
    if (privateChat ? typeof peer !== 'string' || !exactAutomationId(peer) : peer != null)
      throw Error('聊天对象与所选频道不匹配');
    const guildId = exactAutomationId(player.guildId);
    const check = () => {
      current();
      if (channel === 'guild' && (!guildId || guildId !== exactAutomationId(player.guildId)))
        throw Error('联盟已变化或尚未加入，请重新打开联盟频道');
    };
    check();
    const wireChannel = channel === 'guild' ? 2 : 1;
    const name = privateChat ? 'PrivateChatSendRequest' : 'SendChatRequest';
    const body = privateChat ? { type, peerPlayerId: automationWireId(peer), ...(isEmoji ? { message: '', emoji } : { message: text }) }
      : { channel: wireChannel, content: isEmoji ? { type, attachment: { emoji } } : { type, text, attachment: {} } };
    return schedule(async () => {
      if (item?.actId) await loadUnlocks(current);
      let attempted = false, echoed = false;
      const observe = ({ name: event, body: data }) => {
        if (!attempted) return;
        if (privateChat && event === 'SCPrivateChatMessage') {
          const { peer: recipient, record } = data.record ?? {};
          if (exactAutomationId(recipient?.playerId) === peer && record?.side === 1 && record.type === type
            && (isEmoji ? record.emoji === emoji : record.message === text)) echoed = true;
        } else if (!privateChat && (event === 'SCChatReceive' || event === 'SCBatchChatReceive')) {
          const messages = event === 'SCChatReceive' ? [data] : data.messages ?? [];
          if (messages.some(row => row.channel === wireChannel && ownId && exactAutomationId(row.message?.sender?.playerId) === ownId
            && row.message?.content?.type === type
            && (isEmoji ? row.message.content.attachment?.emoji === emoji : row.message.content.text === text))) echoed = true;
        }
      };
      client.on('message', observe);
      try {
        await client.request(name, body, 'OkResponse', 5000, () => {
          check();
          if (item?.actId && !ownedItems?.has(item.actId)) throw Error(item.desc || '尚未解锁这个表情');
          attempted = true;
        });
        return { status: 'sent' };
      } catch (error) {
        if (!attempted) throw error;
        if (error.prompt) {
          const code = error.prompt.prompt, types = client.protocol?.Prompt;
          if (types && code === types.CHAT_CD) throw Error('发言过于频繁，请稍后再发');
          if (types && code === types.CONTAINS_FORBIDDEN_WORDS) throw Error('消息含有游戏限制的词语，请修改后再发');
          throw error;
        }
        return { status: echoed ? 'sent' : 'unknown' };
      } finally {
        client.off('message', observe);
      }
    });
  }
  return { read, profile, emojis, send };
}
