import { isRecord } from "./login-settings";

const record = (value: unknown) => {
  if (!isRecord(value)) throw new Error("家园数据格式无效");
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("家园文本格式无效");
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("家园进度格式无效");
  return value;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("家园状态格式无效");
  return value;
};
const planningStatus = (value: unknown) => {
  if (
    value === "optimal" ||
    value === "feasible" ||
    value === "limited" ||
    value === "unreachable"
  )
    return value;
  throw new Error("家园合成规划状态无效");
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("家园列表格式无效");
  return value;
};
export function parseHomeland(value: unknown) {
  const data = record(value);
  if (!flag(data.available))
    return { available: false as const, reason: text(data.reason) };
  const budget = record(data.budget);
  const warehouse = record(data.warehouse);
  const tech = data.tech === null ? null : record(data.tech);
  return {
    available: true as const,
    name: text(data.name),
    level: count(data.level),
    floor: count(data.floor),
    techLevel: count(data.techLevel),
    coins: count(data.coins),
    spent: count(data.spent),
    stamina: count(data.stamina),
    placed: count(data.placed),
    capacity: count(data.capacity),
    nextLevel: data.nextLevel === null ? null : count(data.nextLevel),
    freeStaminaClaimed: flag(data.freeStaminaClaimed),
    checkedAt: text(data.checkedAt),
    pending: array(data.pending).map(text),
    budget: {
      used: count(budget.used),
      limit: count(budget.limit),
      keep: count(budget.keep),
    },
    warehouse: {
      used: count(warehouse.used),
      capacity: warehouse.capacity === null ? null : count(warehouse.capacity),
    },
    tech: tech
      ? {
          level: count(tech.level),
          name: text(tech.name),
          requirement: count(tech.requirement),
          cost: count(tech.cost),
          attribute: text(tech.attribute),
        }
      : null,
    conditions: array(data.conditions).map((value) => {
      const row = record(value);
      return {
        label: text(row.label),
        have: count(row.have),
        need: count(row.need),
        met: flag(row.met),
      };
    }),
    actions: array(data.actions).map((value) => {
      const row = record(value);
      return {
        id: text(row.id),
        kind: text(row.kind),
        title: text(row.title),
        detail: text(row.detail),
        coinCost: count(row.coinCost),
        reason: text(row.reason),
        token: text(row.token),
        orderSlot: row.orderSlot === null ? null : count(row.orderSlot),
      };
    }),
    orders: array(data.orders).map((value) => {
      const row = record(value);
      const synthesis = row.synthesis === null ? null : record(row.synthesis);
      return {
        slot: count(row.slot),
        limited: flag(row.limited),
        expiresAt: count(row.expiresAt),
        ready: flag(row.ready),
        synthesis: synthesis
          ? {
              merges: count(synthesis.merges),
              stores: count(synthesis.stores),
              takes: count(synthesis.takes),
              steps: synthesis.steps === null ? null : count(synthesis.steps),
              lowerBound:
                synthesis.lowerBound === null
                  ? null
                  : count(synthesis.lowerBound),
              status: planningStatus(synthesis.status),
              reason: text(synthesis.reason),
            }
          : null,
        requirements: array(row.requirements).map((value) => {
          const item = record(value);
          return {
            id: text(item.id),
            name: text(item.name),
            num: count(item.num),
            board: count(item.board),
            warehouse: count(item.warehouse),
          };
        }),
      };
    }),
    floors: array(data.floors).map((value) => {
      const row = record(value);
      return {
        floor: count(row.floor),
        unlockLevel: count(row.unlockLevel),
        unlocked: flag(row.unlocked),
        tasks: array(row.tasks).map((value) => {
          const task = record(value);
          return {
            id: count(task.id),
            done: flag(task.done),
            cost: count(task.cost),
            rewards: array(task.rewards).map((value) => {
              const item = record(value);
              return {
                id: text(item.id),
                name: text(item.name),
                num: count(item.num),
              };
            }),
          };
        }),
      };
    }),
  };
}
export type HomelandView = Extract<
  ReturnType<typeof parseHomeland>,
  { available: true }
>;
export type HomelandAction = HomelandView["actions"][number];
export function parseHomelandOutcome(value: unknown) {
  const data = record(value);
  if (
    !["confirmed", "pending", "rejected", "cancelled"].includes(
      text(data.status),
    )
  )
    throw new Error("家园操作结果未确认，请刷新核对");
  return text(data.message);
}
