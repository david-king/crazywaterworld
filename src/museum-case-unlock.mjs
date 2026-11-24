import { AutomationSkip, exactAutomationId } from './automation-policy.mjs';
import { caseWorkObserved, museumCases, museumFinishKey, planMuseumCaseWork, findMuseumCase } from './museum-cases.mjs';
import { linkOperationResult } from './operation-log.mjs';

const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
export function museumCaseActor(player) {
  const world = exactAutomationId(player?.worldId), role = exactAutomationId(player?.playerId);
  return world && role ? world + ':' + role : null;
}

export function reconcileMuseumCaseWork(ledger, player, museum) {
  const scope = museumCaseActor(player);
  if (!scope || museum?.actor !== scope || !ledger?.keyRecords) return;
  const pending = Object.entries(ledger.keyRecords()).filter(([, r]) => !r.confirmed && r.details?.museumCaseActor === scope);
  if (!pending.length) return;
  const { cases } = museumCases(museum);
  for (const [key, { details }] of pending) {
    if (caseWorkObserved(findMuseumCase(cases, details), details.kind)) ledger.resolveKey(key, true);
  }
}

export async function runMuseumCaseWork(client, protocol, config, step, { player, ledger, guard, enabled }) {
  const scope = museumCaseActor(player), socket = client.socket, epoch = client.connectionEpoch;
  const { exhibitionId, caseIndex } = step.body;
  const finish = step.kind === 'museumCaseFinish';
  const key = finish ? museumFinishKey(exhibitionId, caseIndex, step.finishTime)
    : ['museum-case-unlock', scope, exhibitionId, caseIndex].join(':');
  const check = () => {
    if (!enabled() || client.connected === false || client.socket !== socket || client.connectionEpoch !== epoch || museumCaseActor(player) !== scope)
      throw new AutomationSkip('展位解锁已暂停或账号连接已变化');
  };
  let budget, ticket, writing = false, received = false;
  try {
    check();
    if (!scope || !ledger?.keyRecords || !ledger?.reserve || ![step.request, step.response, 'MuseumInfoRequest',
      'MuseumInfoResponse', 'OnWaterRequest', 'OnWaterResponse'].every(name => protocol[name]))
      throw new AutomationSkip('展位解锁协议、账号或操作记录尚未就绪');
    const previous = ledger.keyRecords()[key];
    if (previous) return { step, ok: false, skipped: true, status: previous.confirmed ? 'waiting' : 'pending',
      reason: '此展位已有施工记录，等待服务器同步' };
    const buildings = config.tables?.BuildingUnlockCfg?.data?.filter(row => row.buildingType === '博物馆') ?? [];
    if (buildings.length !== 1 || !Number.isSafeInteger(buildings[0].playerLevel) || buildings[0].playerLevel < 1
      || !Number.isSafeInteger(player.level) || player.level < buildings[0].playerLevel)
      throw new AutomationSkip('尚未达到博物馆开放等级');
    const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
    check();
    if (!water?.building?.some(b => b.buildingId === buildings[0].buildingId && Number.isSafeInteger(b.level) && b.level > 0))
      throw new AutomationSkip('博物馆尚未建成');
    budget = await guard.before(step);
    check();
    const museum = await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse');
    check();
    const fresh = planMuseumCaseWork(museum, config, clock(client)).find(s => s.kind === step.kind
      && s.body.exhibitionId === exhibitionId && s.body.caseIndex === caseIndex);
    if (!fresh || fresh.finishTime !== step.finishTime || JSON.stringify(fresh.costs) !== JSON.stringify(step.costs))
      throw new AutomationSkip('目标展位或施工条件已变化，等待重新规划');
    ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { museumCaseActor: scope, kind: step.kind, exhibitionId, caseIndex } });
    check();
    writing = true;
    const reply = await client.request(step.request, step.body, step.response, 15000);
    received = true;
    check();
    const updated = reply?.cases?.filter(c => c.caseIndex === caseIndex);
    if (updated?.length !== 1 || !caseWorkObserved(updated[0], step.kind)) throw new Error('施工回执未确认目标展位');
    const after = await client.request('MuseumInfoRequest', {}, 'MuseumInfoResponse');
    check();
    if (!caseWorkObserved(findMuseumCase(museumCases(after).cases, step.body), step.kind)) throw new Error('等待目标展位的施工状态同步');
    ledger.confirm(ticket);
    const entry = { step, ok: true, status: 'confirmed' };
    await guard.after(step, budget, entry);
    return linkOperationResult(entry, budget);
  } catch (error) {
    const notSent = !writing || !received && error.notSent === true;
    const rejected = !received && error.prompt && error.request === step.request;
    if (ticket && (notSent || rejected)) ledger.cancel(ticket);
    if (budget) await guard.cancel(step, budget, { notSent, error });
    return linkOperationResult({ step, ok: false, skipped: error.code === 'AUTOMATION_SKIP',
      status: ticket && !notSent && !rejected ? 'pending' : rejected ? 'rejected' : 'waiting', error: error.message }, budget);
  }
}
