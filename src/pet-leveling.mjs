import { uidText } from './hero-equipment.mjs';

const petLevelStages = [30, 65, 100];

// PetLevelUpRequest addresses a building, while the user's selection addresses a pet.
function petLevelRoster(buildings, pets) {
  const roster = new Map();
  for (const pet of pets) {
    const uid = uidText(pet.uid);
    if (uid && Number.isSafeInteger(pet.level) && pet.level >= 1) roster.set(uid, { uid, pet, buildingId: null });
  }
  for (const building of buildings) {
    const target = roster.get(uidText(building.petServe?.petUid));
    if (target && building.buildingId && building.level > 0) target.buildingId = building.buildingId;
  }
  return roster;
}

export async function readPetLevelRoster(client) {
  const { pets } = await client.request('AllPetRequest', {}, 'AllPetResponse');
  const { building } = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  if (!Array.isArray(pets) || !Array.isArray(building)) throw Error('值守海兽名单尚未同步');
  return petLevelRoster(building, pets);
}

export function petLevelStage(roster, levelUids) {
  // 离岗海兽的等级仍计入整组进度。未读到的 UID 不能视为已达标。
  return petLevelStages.find(stage => levelUids.some(uid => (roster.get(uid)?.pet.level ?? 0) < stage));
}

export function planPetLevels(snapshot, config, preferences, add, note) {
  if (!preferences.enabled || !preferences.levelUp) return;
  if (!preferences.levelUids.length) return note('请先选择要升级的值守海兽');
  const roster = petLevelRoster(snapshot.world.buildings, snapshot.pets);
  const stage = petLevelStage(roster, preferences.levelUids);
  if (!stage) return note('所选海兽都已达到 100 级');
  const selected = preferences.levelUids.map(uid => roster.get(uid));
  if (selected.some(target => !target)) note('升级名单中有海兽未读到，请核对名单');
  if (selected.some(target => target && !target.buildingId && target.pet.level < stage)) {
    note('部分所选海兽尚未达到 ' + stage + ' 级，请安排值守后继续升级');
  }
  const targets = selected.filter(target => target?.buildingId && target.pet.level < stage);
  for (const { uid, pet, buildingId } of targets.sort((a, b) => a.pet.level - b.pet.level)) {
    const level = pet.level + 1;
    const next = config.tables?.PetLevelCfg?.data.find(row => row.level === level);
    if (!Number.isSafeInteger(next?.playerLevel) || next.cost?.length !== 2 ||
        next.cost[0] !== '宠物经验' || !Number.isSafeInteger(next.cost[1]) || next.cost[1] <= 0) {
      note('缺少海兽 ' + level + ' 级升级配置');
      continue;
    }
    if (!(snapshot.player?.level >= next.playerLevel)) {
      note('海兽升至 ' + level + ' 级需要角色达到 ' + next.playerLevel + ' 级');
      continue;
    }
    add({ kind: 'petLevelUp', setting: 'pet.levelUp', request: 'PetLevelUpRequest', response: null,
      body: { buildingId }, costs: [{ id: next.cost[0], num: next.cost[1] }], verify: { petUid: uid, level, stage },
      label: pet.petId + '（' + buildingId + '）升至 ' + level + ' 级，本阶段目标 ' + stage + ' 级' });
  }
}

export async function petLevelConfirmed(client, { petUid, level }) {
  const { pets } = await client.request('AllPetRequest', {}, 'AllPetResponse');
  const pet = pets?.find(row => uidText(row.uid) === petUid);
  return Number.isSafeInteger(pet?.level) && pet.level >= level;
}
