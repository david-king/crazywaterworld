import { AutomationSkip, exactAutomationId } from './automation-policy.mjs';
import { normalize } from './worlds.mjs';

const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const idle = stage => stage && (stage.expedition?.endTime ?? 0) === 0;

function actor(player) {
  const world = exactAutomationId(player?.worldId), role = exactAutomationId(player?.playerId);
  return world && role ? world + ':' + role : null;
}

function sameTrip(stage, trip) {
  return stage?.progress === trip.progress && stage.expedition?.startTime === trip.startTime
    && stage.expedition?.endTime === trip.endTime;
}

// Called with a fresh account snapshot, including on rounds with no due trips.
// Reconcile only this world's records. A matching in-flight trip is left alone.
export function reconcileMuseumClaims(ledger, player, stages) {
  const scope = actor(player);
  if (!scope || !Array.isArray(stages) || !ledger?.keyRecords) return;
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!key.startsWith('museumClaim:' + scope + ':')) continue;
    const trip = record.details, stage = stages.find(row => row.stageId === trip?.stageId);
    if (!trip || !stage || sameTrip(stage, trip)) continue;
    if (!integer(stage.progress) || stage.progress < trip.progress) continue;
    const laterTrip = stage.expedition?.startTime > trip.startTime;
    const cleared = idle(stage) && stage.progress > trip.progress;
    if (laterTrip || cleared) {
      if (!record.confirmed) ledger.resolveKey(key, true);
      ledger.releaseCompletedKey(key);
    }
  }
}

export async function settleMuseumTrip(client, protocol, config, step, { ledger, player, enabled }) {
  const scope = actor(player), trip = { stageId: step.body.stageId, ...step.verify };
  const socket = client.socket, epoch = client.connectionEpoch;
  if (!ledger?.updateKeyDetails || !scope) throw new AutomationSkip('等待探宝账号和领奖记录就绪');
  if (!integer(trip.progress) || !integer(trip.startTime, 1) || !integer(trip.endTime, trip.startTime + 1))
    throw new AutomationSkip('探宝行程或起始进度未完整同步');
  for (const name of ['MuseumInfo','MuseumCompleteExplore','MuseumReward']) {
    if (!protocol[name+'Request'] || !protocol[name+'Response']) throw new AutomationSkip('缺少探宝结算或领奖回执');
  }
  const check = () => {
    if (!enabled() || actor(player) !== scope || client.socket !== socket || client.connectionEpoch !== epoch) throw new AutomationSkip('探宝已暂停，下次从已保存的步骤继续');
  };
  const request = async (name, body) => normalize(await client.request(name+'Request', body, name+'Response', 15000));
  const currentTrip = async () => {
    check();
    const info = await request('MuseumInfo', {});
    check();
    const current = info?.exploreStages?.filter(row => row.stageId === trip.stageId);
    const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
    if (trip.endTime > now || current?.length !== 1 || !sameTrip(current[0], trip)) throw new AutomationSkip('探宝行程已变化，等待重新核对');
  };
  await currentTrip();
  check();
  const key = 'museumClaim:' + scope + ':' + trip.stageId + ':' + trip.startTime;
  let record = ledger.keyRecords()[key];
  const update = details => {
    if (!ledger.updateKeyDetails(key, details, record)) throw new AutomationSkip('探宝领奖记录已变化');
    record = { ...record, details };
  };
  const rejected = (err, name) => err.notSent || err.prompt && err.request === name+'Request';
  if (!record) {
    const details = { ...trip, phase: 'settling' };
    const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details });
    record = ledger.keyRecords()[key];
    let settlement;
    try { settlement = await request('MuseumCompleteExplore', step.body); }
    catch (error) { if (rejected(error, 'MuseumCompleteExplore')) ledger.cancel(ticket); throw error; }
    if (!integer(settlement?.grade, 1) || settlement.grade > 5 || !integer(settlement.progressGain)) throw new Error('探宝评级或进度收益尚未确认');
    update({ ...details, phase: 'ready', grade: settlement.grade, gain: settlement.progressGain });
  }
  if (record.confirmed || record.details.startTime !== trip.startTime || record.details.endTime !== trip.endTime
    || record.details.progress !== trip.progress || record.details.phase !== 'ready') throw new AutomationSkip('上次探宝结果待核对，可在游戏内查看该地图');
  await currentTrip();
  check();
  const ready = record.details;
  update({ ...ready, phase: 'claiming' });
  let reply;
  try { reply = await request('MuseumReward', step.body); }
  catch (error) { if (rejected(error, 'MuseumReward')) update(ready); throw error; }
  const stage = reply?.exploreStage, items = reply?.reward?.asset;
  const max = Math.max(0, ...(config.tables?.MuseumStageStarCfg?.data ?? []).map(row => row.exploreValue));
  const expected = ready.progress + ready.gain;
  const progressed = integer(stage?.progress) && stage.progress >= ready.progress &&
    (ready.gain > 0 && stage.progress >= expected || max > 0 && stage.progress === max && expected >= max);
  if (stage?.stageId !== trip.stageId || !idle(stage) || !progressed || !Array.isArray(items) || !items.length
    || !items.every(item => typeof item.id === 'string' && item.id && integer(item.num, 1))) {
    throw new Error('探宝奖励、进度或队伍释放尚未确认，已保留领奖记录');
  }
  ledger.resolveKey(key, true);
  return { ...reply, settlement: { grade: ready.grade, progressGain: ready.gain } };
}
