import { isRecord } from "./login-settings";

function thumbnail(value: unknown) {
  return typeof value === "string" && value.startsWith("/api/art/icon/")
    ? value
    : "";
}

export function parseChatEmojis(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.owner !== "string" ||
    typeof value.hint !== "string" ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.groups)
  )
    throw Error("表情列表格式无效");
  const items = value.items.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      !Number.isSafeInteger(item.id) ||
      typeof item.group !== "number" ||
      !Number.isSafeInteger(item.group) ||
      typeof item.name !== "string" ||
      typeof item.special !== "boolean"
    )
      throw Error("表情格式无效");
    return {
      id: item.id,
      name: item.name,
      group: item.group,
      special: item.special,
      sticker: thumbnail(item.sticker),
    };
  });
  const groups = value.groups.map((group: unknown) => {
    if (
      !isRecord(group) ||
      typeof group.id !== "number" ||
      !Number.isSafeInteger(group.id)
    )
      throw Error("表情分组格式无效");
    return { id: group.id, icon: thumbnail(group.icon) };
  });
  return { items, groups, owner: value.owner, hint: value.hint };
}

export function parseChat(data: unknown) {
  if (
    !isRecord(data) ||
    typeof data.hint !== "string" ||
    !Array.isArray(data.rows)
  )
    throw Error("聊天记录格式无效");
  const rows = data.rows.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      typeof item.time !== "number" ||
      !Number.isSafeInteger(item.time) ||
      item.time < 0 ||
      item.time > 2147483647 ||
      typeof item.sender !== "string" ||
      typeof item.text !== "string" ||
      typeof item.peerId !== "string" ||
      (item.senderId != null && typeof item.senderId !== "string") ||
      typeof item.own !== "boolean" ||
      typeof item.system !== "boolean"
    )
      throw Error("聊天消息格式无效");
    const { id, time, sender, text, peerId, own, system } = item;
    const parts =
      system && Array.isArray(item.parts)
        ? item.parts.map((part: unknown, index: number) => {
            if (!isRecord(part) || typeof part.text !== "string")
              throw Error("系统公告格式无效");
            const color =
              typeof part.color === "string" &&
              /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(part.color)
                ? part.color
                : "";
            return { index, text: part.text, color, bold: part.bold === true };
          })
        : [];
    return {
      id,
      time,
      sender,
      text,
      peerId,
      senderId: typeof item.senderId === "string" ? item.senderId : "",
      own,
      system,
      parts,
      avatar: thumbnail(item.avatar),
      sticker: thumbnail(item.sticker),
    };
  });
  return { rows, hint: data.hint };
}

function parseMember(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.level !== "number" ||
    typeof value.star !== "number"
  )
    throw Error("展示阵容格式无效");
  return {
    id: value.id,
    name: value.name,
    level: value.level,
    star: value.star,
  };
}

export function parseChatProfile(value: unknown, id: string) {
  if (
    !isRecord(value) ||
    value.id !== id ||
    typeof value.nickname !== "string" ||
    typeof value.own !== "boolean" ||
    typeof value.level !== "number" ||
    typeof value.power !== "string" ||
    !/^\d+$/.test(value.power) ||
    typeof value.title !== "string" ||
    typeof value.guild !== "string" ||
    !Array.isArray(value.heroes)
  )
    throw Error("玩家资料格式无效");
  return {
    nickname: value.nickname,
    avatar: thumbnail(value.avatar),
    own: value.own,
    level: value.level,
    power: BigInt(value.power).toLocaleString("zh-CN"),
    title: value.title,
    guild: value.guild,
    heroes: value.heroes.map(parseMember),
    pet: value.pet == null ? null : parseMember(value.pet),
  };
}
