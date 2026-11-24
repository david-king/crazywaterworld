// 工厂自动生产：购买全局自动生产时长，以及设置/取消单个工厂的自动产物。
//
// 游戏协议（来自客户端 AutoProducePop 与 FactoryPop）：
// - BuyFactoryAutoProduceRequest {} -> BuyFactoryAutoProduceResponse { autoEndTime }
// - SetFactoryAutoProduceRequest { buildingId, productId }（无 Response，失败时推 PromptResponse）
// - CancelFactoryAutoProduceRequest { buildingId }（无 Response，失败时推 PromptResponse）
//
// 注意：没有“关闭全局自动生产并退款”的协议。CancelFactoryAutoProduceRequest
// 只清掉某个工厂的自动产物，已经购买的时长仍然保留。

import { makeTypeResolver, displayBuilding, autoFactoryProducts } from './world.mjs';
import { normalize } from './worlds.mjs';

const AUTO_COST_PARAM = '自动生产钻石消耗';
const AUTO_TIME_PARAM = '自动生产时间';
const BUY_RESPONSE = 'BuyFactoryAutoProduceResponse';

async function readWaterState(client, protocol) {
  if (!protocol?.OnWaterRequest || !protocol?.OnWaterResponse) throw new Error('游戏协议未同步，无法核对自动生产');
  const raw = await client.request('OnWaterRequest', {}, 'OnWaterResponse', 8000);
  const water = normalize(raw);
  const serverNow = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  return { water, serverNow };
}

function waterActive(state) {
  return state.water?.autoProduceForever === true
    || Number(state.water?.autoProduceEndTime) > state.serverNow;
}

function waterTarget(state, buildingId) {
  const raw = (state.water?.building ?? []).find(building => building?.buildingId === buildingId);
  return raw?.factory?.autoProductId || null;
}

function waterSurvey(state, config) {
  const typeOf = makeTypeResolver(config);
  return {
    serverNow: state.serverNow,
    autoProduceForever: state.water?.autoProduceForever === true,
    autoProduceEndTime: Number(state.water?.autoProduceEndTime) || 0,
    stockKnown: false,
    stockCap: 0,
    have: () => 0,
    festivals: [],
    player: null,
    factories: (state.water?.building ?? [])
      .filter(building => building?.factory)
      .map(building => ({ ...building, type: building.type || typeOf(building.buildingId) })),
  };
}

function viewFromWater(config, survey, state) {
  const { costRuby, durationSeconds } = autoProduceConfig(config);
  const forever = state.water?.autoProduceForever === true;
  const endTime = Number(state.water?.autoProduceEndTime) || 0;
  const active = forever || endTime > state.serverNow;
  return {
    forever,
    endTime,
    active,
    remainingSeconds: forever ? null : Math.max(0, Math.floor(endTime - state.serverNow)),
    costRuby,
    durationSeconds,
    ruby: survey?.stockKnown ? survey.have('RUBY') : null,
  };
}

function param(config, name) {
  return config?.tables?.BuildingProduceParamCfg?.data
    ?.find(row => row.paramName === name)?.paramValue;
}

export function autoProduceConfig(config) {
  const costRuby = Number(param(config, AUTO_COST_PARAM));
  const durationSeconds = Number(param(config, AUTO_TIME_PARAM));
  return {
    costRuby: Number.isFinite(costRuby) && costRuby > 0 ? costRuby : 500,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 28800,
  };
}

export function autoProduceView(config, survey) {
  const { costRuby, durationSeconds } = autoProduceConfig(config);
  const now = Number(survey?.serverNow) || Date.now() / 1000;
  const forever = survey?.autoProduceForever === true;
  const endTime = Number(survey?.autoProduceEndTime) || 0;
  const active = forever || endTime > now;
  return {
    forever,
    endTime,
    active,
    remainingSeconds: forever ? null : Math.max(0, Math.floor(endTime - now)),
    costRuby,
    durationSeconds,
    ruby: survey?.stockKnown ? survey.have('RUBY') : null,
  };
}

function requireText(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(name + '不完整，请刷新工厂列表');
  }
  return value.trim();
}

function factoryByBuilding(survey, buildingId) {
  const building = survey.factories.find(factory => factory.buildingId === buildingId);
  if (!building?.factory) throw new Error('工厂不存在或工厂数据未同步');
  return building;
}

function autoTarget(building, survey) {
  const active = survey.autoProduceForever || Number(survey.autoProduceEndTime) > Number(survey.serverNow);
  return {
    active,
    productId: building.factory.autoProductId || null,
    enabled: !!building.factory.autoProductId && active,
  };
}

// 手动自动生产操作走快速路径：不再先读一次完整 OnWater、成功后再读一次。
// UI 已持有当前账号的自动生产状态和目标物料，这里只发送真正的写请求，
// 并用 300ms 的 PromptResponse 窗口确认没有失败提示。这样不会被挂机读取和
// 自动任务队列拖到数秒之后。
async function runFactoryAutoProduceFast(client, payload, { config }) {
  const { costRuby, durationSeconds } = autoProduceConfig(config);
  const action = payload.action;
  const buildingId = payload.buildingId;
  const forever = payload.forever === true;
  let endTime = Number(payload.endTime) || 0;
  let active = payload.active === true || forever || endTime > Math.floor(Date.now() / 1000);
  let bought = false;
  const productId = action === 'cancel' ? null : requireText(payload.productId, '自动生产物料');

  if (action === 'enable' && !active) {
    const response = await client.request('BuyFactoryAutoProduceRequest', {}, BUY_RESPONSE);
    const boughtEndTime = Number(response?.autoEndTime);
    if (!Number.isFinite(boughtEndTime) || boughtEndTime <= 0) throw new Error('购买自动生产返回的结束时间为空');
    endTime = boughtEndTime;
    active = true;
    bought = true;
  }
  if (action !== 'enable' && !active) throw new Error('自动生产尚未开通，请先开通后再设置物料');

  const base = {
    bought,
    action,
    forever: action === 'cancel' ? forever : (bought ? false : forever),
    endTime,
    active: true,
    remainingSeconds: forever ? null : Math.max(0, Math.floor(endTime - Math.floor(Date.now() / 1000))),
    costRuby,
    durationSeconds,
    ruby: Number.isFinite(Number(payload.ruby)) ? Number(payload.ruby) : null,
    confirmed: true,
    ok: true,
  };

  if (action === 'cancel') {
    await client.sendWatch('CancelFactoryAutoProduceRequest', { buildingId }, { window: 300 });
    return {
      ...base,
      buildingId,
      autoProductId: null,
      autoProductName: null,
      label: '已关闭该工厂的自动生产',
    };
  }

  const didSet = payload.currentProductId !== productId;
  if (didSet) {
    await client.sendWatch('SetFactoryAutoProduceRequest', { buildingId, productId }, { window: 300 });
  }
  return {
    ...base,
    buildingId,
    autoProductId: productId,
    autoProductName: payload.productName || productId,
    label: '已设置该工厂的自动生产',
  };
}

export async function runFactoryAutoProduce(client, protocol, payload, { player, enabled = () => true, config } = {}) {
  if (!config) throw new Error('游戏配置未同步，无法读取自动生产价格');
  const action = payload?.action;
  if (!['enable', 'set', 'cancel'].includes(action)) throw new Error('未知的自动生产操作');
  const buildingId = requireText(payload.buildingId, '工厂标识');

  if (!enabled()) throw new Error('请先连接并同步当前账号，再操作自动生产');

  if (payload.fast === true) return runFactoryAutoProduceFast(client, payload, { config, enabled });

  const initialState = await readWaterState(client, protocol);
  if (!enabled()) throw new Error('账号状态已变化，请刷新工厂列表');
  const survey = waterSurvey(initialState, config);
  const building = factoryByBuilding(survey, buildingId);

  if (action === 'cancel') {
    const beforeTarget = autoTarget(building, survey);
    if (!beforeTarget.productId) {
      return {
        ok: true, confirmed: true, bought: false, action,
        buildingId, autoProductId: null, autoProductName: null,
        label: '该工厂本来就没有开启自动生产',
        ...viewFromWater(config, survey, initialState),
      };
    }
    await client.sendWatch('CancelFactoryAutoProduceRequest', { buildingId }, { window: 300 });
    if (!enabled()) throw new Error('账号状态已变化，请刷新工厂列表');
    const afterWater = await readWaterState(client, protocol);
    const afterProductId = waterTarget(afterWater, buildingId);
    const confirmed = afterProductId === null;
    return {
      ok: confirmed,
      confirmed,
      bought: false,
      action,
      buildingId,
      autoProductId: afterProductId,
      autoProductName: afterProductId ? (building.auto || afterProductId) : null,
      label: confirmed
        ? '已关闭' + (displayBuilding(config, building) || buildingId) + '的自动生产'
        : '关闭请求已发送，但自动物料仍未清空，请刷新确认',
      ...viewFromWater(config, survey, afterWater),
    };
  }

  const productId = requireText(payload.productId, '自动生产物料');
  const product = autoFactoryProducts(building, survey, config).find(row => row.productId === productId);
  if (!product) throw new Error('该物料不在这个工厂的可选产物中，请重新选择');

  let bought = false;
  let buyEndTime = null;
  let latestState = initialState;
  let beforeTarget = autoTarget(building, survey);
  if (action === 'enable' && !beforeTarget.active) {
    const response = await client.request('BuyFactoryAutoProduceRequest', {}, BUY_RESPONSE);
    const endTime = Number(response?.autoEndTime);
    if (!Number.isFinite(endTime) || endTime <= 0) throw new Error('购买自动生产返回的结束时间为空');
    buyEndTime = endTime;
    bought = true;
    if (!enabled()) throw new Error('账号状态已变化，请刷新工厂列表');
    const afterBuy = await readWaterState(client, protocol);
    if (!waterActive(afterBuy)) throw new Error('自动生产购买未生效，请刷新后重试');
    latestState = afterBuy;
    beforeTarget = {
      active: true,
      productId: waterTarget(afterBuy, buildingId),
      enabled: !!waterTarget(afterBuy, buildingId),
    };
  }
  if (!beforeTarget.active) throw new Error('自动生产尚未开通，请先开通后再设置物料');

  const didSet = beforeTarget.productId !== productId;
  if (didSet) {
    try {
      await client.sendWatch('SetFactoryAutoProduceRequest', { buildingId, productId }, { window: 300 });
    } catch (error) {
      if (bought) error.message = '自动生产已购买，但设置物料失败：' + error.message;
      throw error;
    }
  }
  if (!enabled()) throw new Error('账号状态已变化，请刷新工厂列表');
  const afterSet = didSet ? await readWaterState(client, protocol) : latestState;
  const afterProductId = waterTarget(afterSet, buildingId);
  const confirmed = afterProductId === productId && waterActive(afterSet);
  return {
    ok: confirmed,
    confirmed,
    bought,
    buyEndTime,
    action,
    buildingId,
    autoProductId: afterProductId,
    autoProductName: afterProductId ? (product.name || product.productId) : null,
    label: confirmed
      ? (bought ? '已消耗钻石开通自动生产，并设置' : '已设置') + (product.name || productId) + '自动生产'
      : '设置请求已发送，但自动物料未同步，请刷新确认',
    ...viewFromWater(config, survey, afterSet),
  };
}
