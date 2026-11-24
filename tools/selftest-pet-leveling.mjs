import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, exportAutomationSettings, importAutomationSettings } from '../src/automation-settings.mjs';
import { planBaseAutomation, runBaseAutomation, surveyBaseAutomation } from '../src/base-automation.mjs';
import { automationWireId, exactAutomationId } from '../src/automation-policy.mjs';
import { pendingOrderMaterialSpends } from '../src/order-reservations.mjs';

const protocol = Object.fromEntries(['AllPetRequest', 'AllPetResponse', 'AllItemRequest', 'AllItemResponse',
  'OnWaterRequest', 'OnWaterResponse', 'PetLevelUpRequest'].map(name => [name, true]));
const config = { tables: { PetLevelCfg: { data: Array.from({ length: 101 }, (_, i) => ({
  level: i + 1, playerLevel: 1, cost: ['宠物经验', (i + 1) * 100],
})) } } };
const ids = ['9007199254740992', '9007199254740993', '9007199254740994'];
let nextAccount = 45000;

function fixture() {
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.pet, { enabled: true, levelUp: true, levelUids: ids.slice(0, 2) });
  const player = { playerId: nextAccount++, worldId: 1001001, level: 40 };
  const pets = ids.map((uid, i) => ({ uid: automationWireId(uid), petId: '蓝宠物1', level: [29, 30, 1][i] }));
  const buildings = pets.map((pet, i) => ({ buildingId: (i + 1) + '号值守建筑', level: 1, petServe: { petUid: pet.uid } }));
  const stock = new Map([['宠物经验', 1000000]]);
  const writes = [];
  const client = {
    connected: true,
    async request(name) {
      if (name === 'AllPetRequest') return { pets: structuredClone(pets) };
      if (name === 'OnWaterRequest') return { building: structuredClone(buildings) };
      if (name === 'AllItemRequest') return { items: [{ itemId: '宠物经验', num: stock.get('宠物经验') }] };
      throw Error('意外请求 ' + name);
    },
    async sendWatch(name, body, { beforeSend }) {
      beforeSend();
      assert.equal(name, 'PetLevelUpRequest');
      writes.push(body.buildingId);
      const building = buildings.find(row => row.buildingId === body.buildingId);
      const pet = pets.find(row => exactAutomationId(row.uid) === exactAutomationId(building.petServe.petUid));
      pet.level++;
      stock.set('宠物经验', stock.get('宠物经验') - pet.level * 100);
    },
  };
  const plan = async () => {
    const snapshot = await surveyBaseAutomation(client, protocol, config, player, settings, { stock, buildings, now: 1 });
    return planBaseAutomation(snapshot, config, settings);
  };
  const run = plan => runBaseAutomation(client, protocol, config, plan, { player, getSettings: () => settings });
  return { settings, player, pets, buildings, stock, writes, client, plan, run };
}

test('整组海兽全部达标后自动进入下一阶段，只在 100 级停止', async () => {
  const f = fixture();
  f.pets[1].level = 48;
  for (let round = 0; round < 100; round++) {
    const [a, b] = f.pets;
    const stage = [30, 65, 100].find(level => a.level < level || b.level < level);
    const plan = await f.plan();
    if (!stage) { assert.equal(plan.actions.length, 0); break; }
    const eligible = [a, b].filter(pet => pet.level < stage).sort((x, y) => x.level - y.level);
    assert.deepEqual(plan.actions.map(step => [step.verify.petUid, step.verify.level, step.verify.stage, step.costs[0].num]),
      eligible.map(pet => [exactAutomationId(pet.uid), pet.level + 1, stage, (pet.level + 1) * 100]));
    assert((await f.run(plan)).every(entry => entry.ok));
  }
  assert.deepEqual(f.pets.map(pet => pet.level), [100, 100, 1]);
});

test('离岗或未读到的海兽仍约束阶段，执行旧计划也会重新核对整组', async () => {
  const f = fixture();
  f.pets[0].level = 30;
  const old = await f.plan(); // 两只均为 30 级，原计划都可升至 31。
  f.buildings[1].petServe.petUid = null;
  const assigned = await f.plan();
  assert.deepEqual(assigned.actions.map(s => s.verify.petUid), [ids[0]]);
  f.settings.pet.levelUids.push(ids[2]);
  f.buildings[2].petServe.petUid = null; // 新勾选的低级海兽已经离开值守。
  assert.equal((await f.plan()).actions.length, 0);
  assert((await f.run(old)).every(entry => entry.skipped));
  f.pets.pop(); // UID 暂时无法从库存确认，仍不能跨过 30。
  assert.equal((await f.plan()).actions.length, 0);
  f.pets[0].level = 29;
  assert.deepEqual((await f.plan()).actions.map(step => step.verify.level), [30]);
  assert.deepEqual(f.writes, []);
});

test('名单双开关、经验库存及最新值守关系共同约束写入', async () => {
  const f = fixture(), original = await f.plan();
  f.buildings[0].petServe.petUid = f.pets[2].uid;
  assert.equal((await f.run(original))[0].skipped, true);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  f.buildings[0].petServe.petUid = f.pets[0].uid;
  f.settings.pet.levelUids = [];
  assert.equal((await f.plan()).actions.length, 0);
  assert.equal((await f.run(original))[0].skipped, true);
  f.settings.pet.levelUids = ids.slice(0, 2);
  f.stock.set('宠物经验', 2999);
  assert.equal((await f.plan()).actions.length, 0);
  assert.equal((await f.run(original))[0].skipped, true);
  f.stock.set('宠物经验', 3000);
  for (const [group, key] of [['pet', 'levelUp'], ['pet', 'enabled'], ['loop', 'world']]) {
    f.settings[group][key] = false;
    assert.equal((await f.plan()).actions.length, 0);
    await f.run(original);
    f.settings[group][key] = true;
  }
  assert.deepEqual(f.writes, []);
});

test('其他海兽升级或经验扣减不能确认目标升级，未知结果阻止重发', async () => {
  const f = fixture(), plan = await f.plan();
  f.client.sendWatch = async () => {
    f.writes.push('sent');
    f.pets[1].level++;
    f.stock.set('宠物经验', 10000);
  };
  assert.equal((await f.run(plan))[0].ok, false);
  assert.equal((await f.run(plan))[0].skipped, true);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  f.pets[0].level++;
  assert.equal((await f.run(plan))[0].skipped, true);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  assert.deepEqual(f.writes, ['sent']);
});

test('老账号保留升级开关与名单，旧停止等级不再保存或参与升级', async () => {
  const old = exportAutomationSettings(defaultSettings());
  old.version = 58;
  for (const key of ['levelUp', 'levelUids']) delete old.settings.pet[key];
  const settings = importAutomationSettings(old);
  assert.deepEqual(settings.pet, defaultSettings().pet);
  const f = fixture();
  for (const oldLimit of [30, 65, 100]) {
    const previous = exportAutomationSettings(f.settings);
    previous.version = 59;
    previous.settings.pet.targetLevel = oldLimit;
    const migrated = importAutomationSettings(previous);
    assert.deepEqual(migrated.pet, f.settings.pet);
    assert.deepEqual(exportAutomationSettings(previous.settings).settings.pet, migrated.pet);
    f.settings.pet = migrated.pet;
    f.pets[0].level = f.pets[1].level = 65;
    assert.deepEqual((await f.plan()).actions.map(step => step.verify.stage), [100, 100]);
  }
  settings.pet.levelUids = [Number(ids[0])];
  assert.throws(() => exportAutomationSettings(settings), error => !!error.fields['pet.levelUids']);
});
