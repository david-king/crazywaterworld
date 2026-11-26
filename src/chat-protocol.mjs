// v77 replaced the integer channel enum with ChatChannel { type, id? }.
// Select the request shape from this connection's protocol, since existing
// connections and explicit older bundles can still use the integer form.
export function chatChannelType(channel) {
  return channel && typeof channel === 'object' ? channel.type : channel;
}

export function publicChatChannel(protocol, type) {
  if (type !== 1 && type !== 2) throw new Error('公共聊天频道无效');
  return typeof protocol?.ChatChannel?.encode === 'function' ? { type } : type;
}
