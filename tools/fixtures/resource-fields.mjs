// 虚构账号、地图和配置；协议往返使用本机 protobuf，不连接游戏。
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../../src/proto.mjs';

const protocol = loadProtocol();
const table = data => ({ data });
let nextPlayer = 9007199254940000n;

export function resourceFieldFixture() {
  const playerId = String(++nextPlayer);
  const player = protocol.LoginResponse.decode(protocol.LoginResponse.encode({ playerInfo: {
    playerId, nickname: '资源田验证船长', guildId: '1007', worldId: '1001001',
    scenarioId: 1, level: 36, worldOpenTime: Math.floor(Date.now() / 1000) - 86400 * 30,
  } }).finish()).playerInfo;
  const state = {
    fuel: 6000, maxNum: 5, fields: [],
    cities: [{ id: 1, guildIdx: 7 }, { id: 2, guildIdx: 7 }, { id: 3, guildIdx: 8 }],
    guilds: [{ id: '1007', level: 8, name: '潮汐验证联盟' }, { id: '1008', level: 6, name: '远海验证联盟' }],
    merge: { worldIds: [], matchMaking: false, executeTs: 0 },
    buildings: [1, 2, 3].map(n => ({ buildingId: n + '远征船', level: 1,
      fleet: { formation: { heroPositions: [{ heroId: '兰博', pos: { x: 0, y: 0 } }] } } })),
    fleets: [1, 2, 3].map(n => ({ buildingId: n + '远征船', state: 1, durability: 2000,
      maxDura: 2000, power: 200000, cityId: 1, curGridIdx: 0, targetGridIdx: 0,
      treasureLootUid: 0, owner: { playerId, guildId: '1007' } })),
    mapFields: [
      { gridIdx: 10, cityId: 1, resType: 3 }, { gridIdx: 11, cityId: 1, resType: 2 },
      { gridIdx: 12, cityId: 1, resType: 1 }, { gridIdx: 20, cityId: 2, resType: 3 },
      { gridIdx: 21, cityId: 2, resType: 2 }, { gridIdx: 22, cityId: 2, resType: 1 },
      { gridIdx: 30, cityId: 3, resType: 3 }, { gridIdx: 40, cityId: 4, resType: 3 },
    ],
  };
  const config = { tables: {
    ModuleOpenCfg: table([{ moduleId: '世界', playerLevel: 16 }]),
    WorldParamCfg: table([{ paramName: '资源地消耗汽油', paramValue: 300 },
      { paramName: '资源地消耗耐久', paramValue: 0 }, { paramName: '资源地初始占领数量', paramValue: 10 }]),
    '1_CityCfg': table([
      { id: 1, name: '验证主城', level: 1, resLevel: 1, guildIndex: 7 },
      // 故意让城市等级与资源等级不同，防止实现误用 level。
      { id: 2, name: '验证港湾', level: 5, resLevel: 4, guildIndex: 0 },
      { id: 3, name: '敌盟海港', level: 8, resLevel: 8, guildIndex: 0 },
      { id: 4, name: '归属未同步城市', level: 8, resLevel: 8, guildIndex: 0 },
    ]),
    '1_ResFieldTypeCfg': table([1, 2, 3].flatMap(type => Array.from({ length: 8 }, (_, index) => ({
      season: 1, type, level: index + 1, suggestPower: [25000, 48000, 115000, 140000, 205000, 235000, 325000, 375000][index],
      resId: type, product: [['公会科技点', '种子', '汽油'][type - 1], 360 + index * 60],
    })))),
    ResFiledBaseCfg: table([{ id: 1, name: '工厂' }, { id: 2, name: '绿洲' }, { id: 3, name: '油罐' }]),
  } };
  const map = {
    scenarioId: 1, width: 8, height: 8, tileWidth: 100, tileHeight: 50,
    cityInfo: { 1: { gridIdx: 1 }, 2: { gridIdx: 2 }, 3: { gridIdx: 3 }, 4: { gridIdx: 4 } },
    fieldAt: grid => state.mapFields.find(field => field.gridIdx === grid) ?? null,
    cityAt: grid => state.mapFields.find(field => field.gridIdx === grid)?.cityId ?? 0,
  };
  const client = new EventEmitter();
  client.connected = true; client.serverClockOffsetMs = 0; client.reads = []; client.writes = [];
  const f = { player, protocol, config, state, map, client, mapLoader: async () => map,
    beforeRead: null, afterWrite: null, reject: false, unknown: false, rejectRequest: null, unknownRequest: null, occupyImmediately: false };
  const time = () => Math.floor((Date.now() + client.serverClockOffsetMs) / 1000);
  const emit = (name, body) => client.emit('message', { name,
    body: protocol[name].decode(protocol[name].encode(body).finish()) });
  client.request = async (name, body = {}, reply = name.replace(/Request$/, 'Response')) => {
    if (!protocol[name] || !protocol[reply]) throw Error('真实协议中不存在：' + name + '/' + reply);
    protocol[name].decode(protocol[name].encode(body).finish());
    client.reads.push({ name, body: structuredClone(body) });
    const override = await f.beforeRead?.(name, body); if (override !== undefined) return override;
    let result;
    switch (name) {
      case 'WorldInfoRequest': result = { cities: state.cities, fleets: state.fleets }; break;
      case 'MyResFieldsRequest': result = { info: { fields: state.fields, maxNum: state.maxNum } }; break;
      case 'MyFleetsRequest': result = { fleets: state.fleets }; break;
      case 'AllGuildAbstractionRequest': result = { guilds: state.guilds }; break;
      case 'OnWaterRequest': result = { building: state.buildings }; break;
      case 'AllItemRequest': result = { items: [{ itemId: '汽油', num: state.fuel }] }; break;
      case 'UniteWorldsPlanRequest': result = state.merge; break;
      case 'RadarInfoRequest': result = { radarInfo: { events: [] } }; break;
      default: throw Error('资源田离线夹具禁止未声明读取：' + name);
    }
    return protocol[reply].decode(protocol[reply].encode(result).finish());
  };
  client.sendWatch = async (name, body, { beforeSend } = {}) => {
    if (!['ChallengeResFieldRequest', 'GiveUpResFieldRequest'].includes(name)) throw Error('资源田离线夹具禁止未声明写入：' + name);
    beforeSend?.();
    protocol[name].decode(protocol[name].encode(body).finish());
    client.writes.push({ name, body: structuredClone(body) });
    if (f.reject || f.rejectRequest === name) throw Object.assign(Error('模拟服务端明确拒绝'), { prompt: {}, request: name });
    if (f.unknown || f.unknownRequest === name) return;
    if (name === 'ChallengeResFieldRequest') {
      for (const id of body.fleetBuildingIds) {
        const fleet = state.fleets.find(row => row.buildingId === id);
        if (!fleet) throw Error('夹具无此舰队：' + id);
        Object.assign(fleet, { state: 2, targetGridIdx: body.resFieldGridIdx, startGridIdx: 1,
          moveStartTs: time(), moveEndTs: time() + 60 });
        state.fuel -= 300;
      }
      emit('SCMyFleetUpdate', { fleets: state.fleets });
      if (f.occupyImmediately) f.finish(body.resFieldGridIdx, true);
    } else {
      state.fields = state.fields.filter(row => row.gridIdx !== body.resFieldGridIdx);
      emit('SCResFieldInfo', { info: { fields: state.fields, maxNum: state.maxNum } });
    }
    await f.afterWrite?.(name, body);
  };
  f.returnFleet = id => {
    Object.assign(state.fleets.find(row => row.buildingId === id), { state: 1, curGridIdx: 0, targetGridIdx: 0 });
    emit('SCMyFleetUpdate', { fleets: state.fleets });
  };
  f.finish = (grid, won = true) => {
    const field = map.fieldAt(grid); if (!field) throw Error('夹具中不是资源田：' + grid);
    emit('SCResFieldCampaignEnd', { resFieldGridIdx: grid, isWin: won });
    if (won && !state.fields.some(row => row.gridIdx === grid)) {
      state.fields.push({ gridIdx: grid, cityId: field.cityId, type: field.resType });
      emit('SCResFieldInfo', { info: { fields: state.fields, maxNum: state.maxNum } });
    }
    for (const fleet of state.fleets.filter(row => row.targetGridIdx === grid)) f.returnFleet(fleet.buildingId);
  };
  client.stop = () => { client.connected = false; };
  return f;
}
