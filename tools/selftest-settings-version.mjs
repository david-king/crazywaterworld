// Version migration uses synthetic settings and a temporary data directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION, defaultSettings, migrateSettingsVersion,
  importAutomationSettings, exportAutomationSettings, loadAutomationSettings, loadRecoverableAutomationSettings, saveAutomationSettings,
  nativeTaskValues, validateSettings, settingsUiRules, settingsFromNative, applyNativeTask,
} from '../src/automation-settings.mjs';
import { automationTasks, taskSettings } from '../src/automation.mjs';
import { automationControls } from '../src/automation-controls.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-version-'));
const file = path.join(directory, 'settings.json');
let passed = 0;
function test(name, work) { work(); passed++; console.log('通过：' + name); }
function legacySettings() {
  const settings = defaultSettings();
  settings.schedule.stageAuto = true;
  settings.schedule.radarAuto = true;
  settings.schedule.museumExplore = true;
  settings.building.collect = false;
  settings.factory.gain = true;
  settings.radar.enabled = false;
  settings.museum.enabled = false;
  settings.gather.fishing = false;
  delete settings.progression;
  delete settings.login;
  delete settings.merchant;
  delete settings.silicon;
  delete settings.factory.checkEverySeconds;
  delete settings.cityWar.defenceFleetIds;
  delete settings.cityWar.targetPriority;
  delete settings.cityWar.nativeCommissionLimit;
  delete settings.cityWar.defenceTargetMode;
  delete settings.cityWar.defenceTargetPriority;
  delete settings.cityWar.defenceCityRefs;
  delete settings.gather.enabled;
  delete settings.museum.runEnabled;
  delete settings.radar.runEnabled;
  delete settings.heroRaid.challenge;
  delete settings.heroRaid.retryTimes;
  delete settings.heroRaid.lottery;
  return settings;
}

try {
  test('世界Boss逐队阵容兼容旧配置，绑定验证与往返保存保留选择', () => {
    const old = defaultSettings(); old.worldBoss.fleetIds = ['1远征船', '2远征船'];
    old.worldBoss.enabled = true; delete old.worldBoss.fleetPresets;
    const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 10, settings: old });
    assert.deepEqual(upgraded.worldBoss, { ...old.worldBoss, fleetPresets: [] });
    assert.deepEqual(validateSettings(old).worldBoss, upgraded.worldBoss, '旧页面保存兼容新增空绑定');
    assert(!Object.hasOwn(old.worldBoss, 'fleetPresets'), '不修改输入');
    const settings = defaultSettings();
    settings.lineups.presets = [{ id: 'boss', name: '首领队', formation: { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' } }];
    settings.worldBoss.fleetIds = ['1远征船', '2远征船'];
    settings.worldBoss.fleetPresets = [{ buildingId: '1远征船', presetId: 'boss' }];
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), validateSettings(settings));
    const paused = structuredClone(settings); paused.worldBoss.fleetIds = [];
    assert.deepEqual(validateSettings(paused).worldBoss.fleetPresets, settings.worldBoss.fleetPresets, '取消勾选保留下次使用的阵容');
    for (const bindings of [null, {}, [{ buildingId: '0远征船', presetId: 'boss' }],
      [{ buildingId: '1远征船', presetId: 'missing' }], [...settings.worldBoss.fleetPresets, ...settings.worldBoss.fleetPresets],
      [{ buildingId: '1远征船', presetId: 'boss', extra: true }]]) {
      const invalid = structuredClone(settings); invalid.worldBoss.fleetPresets = bindings;
      assert.throws(() => validateSettings(invalid), error => !!error.fields?.['worldBoss.fleetPresets']);
    }
    assert.deepEqual(settingsFromNative({}).worldBoss.fleetPresets, []);
  });

  test('世界Boss旧、新领奖开关合并后保留启用状态和独立首战配置', () => {
    for (const version of [1, 9]) for (const legacyEnabled of [false, true]) for (const rewardsEnabled of [false, true]) for (const dispatchEnabled of [false, true]) {
      const settings = defaultSettings();
      Object.assign(settings.schedule, { worldBossDamage: legacyEnabled, worldBossRewards: rewardsEnabled });
      Object.assign(settings.worldBoss, { enabled: dispatchEnabled, fleetIds: ['2远征船'], minDurabilityPercent: 63 });
      const before = structuredClone(settings);
      const expected = structuredClone(settings);
      expected.schedule.worldBossRewards = legacyEnabled || rewardsEnabled;
      delete expected.schedule.worldBossDamage;
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        boss: { settingsVersion: version, revision: 3, settings },
        other: { settingsVersion: version, revision: 2, settings },
      } }));
      const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('boss', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }), expected);
      assert.deepEqual(fs.readFileSync(file), bytes, '读取只在内存合并');
      assert.deepEqual(settings, before, '迁移不修改输入');
      const saved = saveAutomationSettings('boss', loaded.settings, { file, revision: loaded.revision });
      assert.deepEqual(loadAutomationSettings('boss', { file }).settings, expected);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), expected);
      assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.other.settings, before, '不改写其他账号');
      const disabled = structuredClone(saved.settings);
      disabled.schedule.worldBossRewards = false;
      saveAutomationSettings('boss', disabled, { file, revision: saved.revision });
      const restarted = loadAutomationSettings('boss', { file }).settings;
      assert.deepEqual(restarted, disabled);
      const tasks = nativeTaskValues(restarted, { worldBossDamage: true, worldBossRewards: true });
      assert.equal(tasks.worldBossRewards, false, '关闭统一开关后旧任务值不能重新开启');
      assert(!Object.hasOwn(tasks, 'worldBossDamage'));
    }
  });

  test('世界Boss原生旧任务和旧页面保存迁移为统一领奖开关', () => {
    const defaults = defaultSettings();
    assert.equal(defaults.worldBoss.enabled, false);
    assert.equal(defaults.schedule.worldBossRewards, false);
    assert(!Object.hasOwn(defaults.schedule, 'worldBossDamage'));
    assert(!automationTasks.some(task => task.key === 'worldBossDamage'));
    assert(!automationControls.some(control => control.key === 'schedule.worldBossDamage'));
    for (const legacyEnabled of [false, true]) for (const rewardsEnabled of [false, true]) {
      const native = { worldBossDamage: legacyEnabled, worldBossRewards: rewardsEnabled };
      const expected = legacyEnabled || rewardsEnabled;
      assert.equal(taskSettings(native).worldBossRewards, expected);
      assert(!Object.hasOwn(taskSettings(native), 'worldBossDamage'));
      const migrated = settingsFromNative(native);
      assert.equal(migrated.schedule.worldBossRewards, expected);
      assert.equal(migrated.worldBoss.enabled, false, '领奖选择不自动授权首战派遣');
      assert(!Object.hasOwn(migrated.schedule, 'worldBossDamage'));
      const disabled = applyNativeTask(migrated, 'worldBossRewards', false);
      assert.deepEqual(applyNativeTask(disabled, 'worldBossDamage', true), disabled, '退役入口不能重开领奖');
      assert.equal(importAutomationSettings(exportAutomationSettings(disabled)).schedule.worldBossRewards, false);
    }
    const oldPage = defaultSettings(); oldPage.schedule.worldBossDamage = true;
    const normalized = validateSettings(oldPage);
    assert.equal(normalized.schedule.worldBossRewards, true, '已打开的旧页面仍能保存原先的领奖选择');
    assert(!Object.hasOwn(normalized.schedule, 'worldBossDamage'));
    normalized.schedule.worldBossRewards = false;
    assert.equal(importAutomationSettings(exportAutomationSettings(normalized)).schedule.worldBossRewards, false);
    for (const key of ['worldBossDamage', 'worldBossRewards']) {
      const legacy = defaultSettings(); legacy.schedule[key] = 'true';
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: 9, settings: legacy }),
        error => !!error.fields?.['schedule.' + key]);
    }
  });

  test('汽油限制和城战接续次数上限从旧文件、导入和旧页面保存中移除', () => {
    const expected = defaultSettings();
    Object.assign(expected.resources, { allowDiamonds: true, diamondDailyLimit: 1234, diamondThreshold: 50 });
    Object.assign(expected.cityWar, { enabled: true, fleetIds: ['1远征船'], autoRepair: true, nativeCommissionLimit: 2, repairBelowPercent: 65 });
    Object.assign(expected.treasure, { autoRepair: true, dailyDispatchLimit: 12, dailyDiamondLimit: 321 });
    Object.assign(expected.pirateHunt, { enabled: true, fleetIds: ['1远征船'], maxFailures: 4 });
    Object.assign(expected.silicon, { dailyRewardLimit: 5 });
    Object.assign(expected.silicon.fleets[0], { autoRepair: true, dailyAttackLimit: 11, marchDailyDiamonds: 200 });
    const legacy = structuredClone(expected);
    const retired = {
      worldBoss: { petrolReserve: 999999 },
      radar: { petrolReserve: 1000, dailyPetrolLimit: 1 },
      pirateHunt: { petrolReserve: 1234, fuelBudget: 1 },
      treasure: { petrolReserve: 99999, maxRepairCost: 1, dailyRepairPetrolLimit: 1 },
      cityWar: { petrolReserve: 99999, maxRepairCost: 1, dailyPetrolLimit: 1, dailyDispatchLimit: 7 },
      silicon: { petrolReserve: 99999, dailyPetrolLimit: 1 },
    };
    for (const [group, values] of Object.entries(retired)) Object.assign(legacy[group], values);
    legacy.silicon.fleets.forEach((fleet, index) => { fleet.maxRepairCost = index + 1; });
    const before = structuredClone(legacy);
    for (const version of [1, 2, 3, 17, SETTINGS_SCHEMA_VERSION]) {
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        fuel: { settingsVersion: version, revision: 8, settings: legacy },
        other: { settingsVersion: version, revision: 3, settings: legacy },
      } }));
      const bytes = fs.readFileSync(file);
      const loaded = loadAutomationSettings('fuel', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: legacy }), expected);
      assert.deepEqual(validateSettings(legacy), expected, '旧页面仍可保存，已移除的限制不再进入当前配置');
      assert.deepEqual(fs.readFileSync(file), bytes, '读取不会隐式写盘');
      assert.deepEqual(legacy, before, '迁移不修改传入对象');
      const saved = saveAutomationSettings('fuel', legacy, { file, revision: loaded.revision });
      assert.equal(saved.revision, 9);
      assert.deepEqual(loadAutomationSettings('fuel', { file }).settings, expected);
      assert.deepEqual(exportAutomationSettings(legacy).settings, expected);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), expected);
      const store = JSON.parse(fs.readFileSync(file));
      assert.equal(store.accounts.fuel.settingsVersion, SETTINGS_SCHEMA_VERSION);
      assert.deepEqual(store.accounts.other.settings, before, '保存一个账号不改写其他账号');
    }
    for (const [group, fields] of Object.entries(retired)) for (const field of Object.keys(fields)) {
      assert(!Object.hasOwn(defaultSettings()[group], field));
      assert(!Object.hasOwn(settingsUiRules().numbers, group + '.' + field));
    }
    for (let index = 0; index < 3; index++) {
      assert(!Object.hasOwn(defaultSettings().silicon.fleets[index], 'maxRepairCost'));
      assert(!Object.hasOwn(settingsUiRules().numbers, 'silicon.fleets.' + index + '.maxRepairCost'));
    }
    const unknown = structuredClone(legacy); unknown.radar.unknownPetrolLimit = 1;
    assert.throws(() => validateSettings(unknown), error => !!error.fields?.['radar.unknownPetrolLimit']);
    const invalid = structuredClone(legacy); invalid.silicon.fleets[0].dailyAttackLimit = -1;
    assert.throws(() => validateSettings(invalid), error => !!error.fields?.['silicon.fleets.0.dailyAttackLimit']);
  });

  test('移除城战加速总开关、共享日限额和单次上限，旧文件及旧页面保留逐队和全局钻石设置', () => {
    const expected = defaultSettings();
    Object.assign(expected.resources, { allowDiamonds: true, diamondDailyLimit: 1234, diamondThreshold: 80 });
    Object.assign(expected.fleetSpeed.fleets[0], {
      repair: true, march: false,
      repairDailyDiamonds: 200, marchDailyDiamonds: 120, repairSmartSave: true,
    });
    Object.assign(expected.fleetSpeed.fleets[1], { march: true, marchDailyDiamonds: 300 });
    assert(!Object.hasOwn(defaultSettings().fleetSpeed, 'dailyDiamondLimit'));
    assert(!Object.hasOwn(settingsUiRules().numbers, 'fleetSpeed.dailyDiamondLimit'));
    for (const [enabled, dailyDiamondLimit] of [[false, 0], [false, 1], [true, 999999]]) for (const version of [1, 2, 3, 12, 16, SETTINGS_SCHEMA_VERSION]) {
      const legacy = structuredClone(expected);
      Object.assign(legacy.fleetSpeed, { enabled, dailyDiamondLimit });
      Object.assign(legacy.fleetSpeed.fleets[0], { repairMaxDiamonds: dailyDiamondLimit, marchMaxDiamonds: 10 });
      legacy.fleetSpeed.fleets[1].marchMaxDiamonds = 40;
      const before = structuredClone(legacy);
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        speed: { settingsVersion: version, revision: 8, settings: legacy },
        other: { settingsVersion: version, revision: 3, settings: legacy },
      } }));
      const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('speed', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: legacy }), expected);
      assert.deepEqual(validateSettings(legacy), expected);
      assert.deepEqual(fs.readFileSync(file), bytes, '读取只在内存迁移');
      const saved = saveAutomationSettings('speed', legacy, { file, revision: loaded.revision });
      assert.equal(saved.revision, 9);
      assert.deepEqual(loadAutomationSettings('speed', { file }).settings, expected);
      assert.deepEqual(exportAutomationSettings(legacy).settings, expected);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), expected);
      assert.deepEqual(migrateSettingsVersion(migrateSettingsVersion(legacy, 3), 3), expected);
      assert.deepEqual(legacy, before, '规范化不修改输入对象');
      const store = JSON.parse(fs.readFileSync(file));
      assert.equal(store.accounts.speed.settingsVersion, SETTINGS_SCHEMA_VERSION);
      assert.deepEqual(store.accounts.other.settings, before, '不改写其他账号');
    }
    const unknown = structuredClone(expected); unknown.fleetSpeed.unknownDiamondLimit = 1;
    assert.throws(() => validateSettings(unknown), error => !!error.fields?.['fleetSpeed.unknownDiamondLimit']);
    for (const mutate of [
      settings => { settings.fleetSpeed.fleets[0].repairDailyDiamonds = -1; },
      settings => { settings.resources.diamondDailyLimit = -1; },
      settings => { settings.fleetSpeed.fleets[0].repair = 'true'; },
    ]) {
      const invalid = structuredClone(expected); mutate(invalid);
      assert.throws(() => validateSettings(invalid));
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: 3, settings: invalid }));
    }
  });

  test('联盟求助次数补全旧配置，保留显式次数并校验边界', () => {
    const settings = defaultSettings();
    Object.assign(settings.alliance, { enabled: true, mutual: true, autoAsk: true, helpDailyLimit: 7 });
    delete settings.alliance.askDailyLimit;
    const before = structuredClone(settings);
    for (const version of [1, SETTINGS_SCHEMA_VERSION]) {
      fs.writeFileSync(file, JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, accounts: {
        ask: { settingsVersion: version, settings, revision: 3 },
      } }));
      const bytes = fs.readFileSync(file);
      const loaded = loadAutomationSettings('ask', { file });
      const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version, settings });
      assert.deepEqual(loaded.settings, imported);
      assert.deepEqual(loaded.settings.alliance, { ...before.alliance, askDailyLimit: 20 });
      assert.deepEqual(fs.readFileSync(file), bytes, '补全只在内存进行');
      assert.deepEqual(settings, before, '补全不修改输入');
      saveAutomationSettings('ask', loaded.settings, { file, revision: loaded.revision });
      assert.deepEqual(loadAutomationSettings('ask', { file }).settings, imported);
    }
    for (const askDailyLimit of [0, 7, 1000]) {
      const explicit = defaultSettings();
      explicit.alliance.askDailyLimit = askDailyLimit;
      assert.equal(importAutomationSettings(exportAutomationSettings(explicit)).alliance.askDailyLimit, askDailyLimit);
      const loaded = loadAutomationSettings('ask', { file });
      saveAutomationSettings('ask', explicit, { file, revision: loaded.revision });
      assert.equal(loadAutomationSettings('ask', { file }).settings.alliance.askDailyLimit, askDailyLimit);
    }
    for (const askDailyLimit of [-1, 1001, 1.5, '20', null, undefined]) {
      const invalid = defaultSettings();
      invalid.alliance.askDailyLimit = askDailyLimit;
      assert.throws(() => validateSettings(invalid), error => !!error.fields?.['alliance.askDailyLimit']);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: SETTINGS_SCHEMA_VERSION, settings: invalid }),
        error => !!error.fields?.['alliance.askDailyLimit']);
    }
  });

  test('旧互助开关在读取、导入、保存和重启后始终停用，不改变新版联盟授权', () => {
    for (const version of [1, SETTINGS_SCHEMA_VERSION]) for (const enabled of [false, true]) for (const mutual of [false, true]) {
      const settings = defaultSettings();
      settings.schedule.guildAidCollect = settings.schedule.guildAidHelp = true;
      Object.assign(settings.alliance, { enabled, mutual, autoHelp: true, autoAsk: true, recruit: true, autoTech: true,
        allowedMaterials: ['木材'], stockReserve: 123, helpDailyLimit: 7 });
      const document = { format: SETTINGS_FORMAT, version, settings };
      fs.writeFileSync(file, JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, accounts: {
        aid: { settingsVersion: version, settings, revision: 3 },
      } }));
      const loaded = loadAutomationSettings('aid', { file });
      for (const normalized of [loaded.settings, importAutomationSettings(document), validateSettings(settings)]) {
        assert.equal(normalized.schedule.guildAidCollect, false);
        assert.equal(normalized.schedule.guildAidHelp, false);
        assert.deepEqual(normalized.alliance, settings.alliance, '不自动开启联盟或互助，也不改已选分项和限制');
      }
      saveAutomationSettings('aid', loaded.settings, { file, revision: loaded.revision });
      const restarted = loadAutomationSettings('aid', { file }).settings;
      assert.deepEqual(restarted, loaded.settings);
      assert.equal(exportAutomationSettings(restarted).settings.schedule.guildAidHelp, false);
      assert.equal(settings.schedule.guildAidHelp, true, '规范化不修改输入对象');
    }
  });

  test('旧商人工厂任务迁移为普通建筑配置，保留原建造升级授权', () => {
    assert(!automationTasks.some(task => task.key === 'weekFactory'));
    assert(!automationControls.some(control => control.key === 'schedule.weekFactory'));
    assert(!Object.hasOwn(taskSettings({ weekFactory: true }), 'weekFactory'));
    for (const oldValue of [true, false]) {
      for (const upgrade of [true, false]) {
        const settings = defaultSettings();
        settings.schedule.weekFactory = oldValue;
        settings.building.build = false;
        settings.building.upgrade = upgrade;
        const original = structuredClone(settings);
        const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
        fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { factory: { settings, revision: 5 } } }));
        const stored = loadAutomationSettings('factory', { file });
        assert.deepEqual(settings, original);
        assert.deepEqual(stored.settings, imported);
        assert.equal(imported.building.build, false);
        assert.equal(imported.building.upgrade, upgrade);
        assert(!Object.hasOwn(imported.schedule, 'weekFactory'));
        assert(!Object.hasOwn(nativeTaskValues(imported, { weekFactory: oldValue }), 'weekFactory'));
        const saved = saveAutomationSettings('factory', imported, { file, revision: stored.revision });
        assert.equal(saved.revision, 6);
        assert.deepEqual(loadAutomationSettings('factory', { file }).settings, imported);
        assert.deepEqual(importAutomationSettings(exportAutomationSettings(imported)), imported);
      }
    }
  });
  test('版本1导入集中补全历史字段，显式选择和输入对象保持原值', () => {
    const settings = legacySettings();
    const before = structuredClone(settings);
    const document = { format: 'crazywaterword-automation', version: 1, settings };
    const migrated = importAutomationSettings(document);
    assert.deepEqual(settings, before);
    assert.equal(migrated.progression.mainline, true);
    assert.equal(migrated.schedule.radarAuto, undefined);
    assert.equal(migrated.schedule.museumExplore, undefined);
    assert.equal(migrated.radar.enabled, true);
    assert.deepEqual(migrated.radar.fleetIds, []);
    assert.equal(migrated.museum.enabled, true);
    assert(!Object.hasOwn(migrated.museum, 'claim'));
    assert(!Object.hasOwn(migrated.museum, 'explore'));
    assert.equal(migrated.building.collect, false);
    assert.equal(migrated.factory.gain, true);
    assert.equal(migrated.gather.fishing, false);
    assert.equal(migrated.factory.checkEverySeconds, 30);
    assert.deepEqual(migrated.heroRaid, { enabled: false, challenge: false, retryTimes: 10, orders: false, lottery: false, rewards: false });
    assert.deepEqual(migrated.cityWar.defenceFleetIds, []);
    const once = migrateSettingsVersion(settings, 1);
    assert.deepEqual(migrateSettingsVersion(once, 1), once);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(migrated)), migrated);
  });
  test('旧文件加载只在内存迁移，明确保存后使用原版本冲突检查', () => {
    const settings = legacySettings();
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old: { settings, revision: 7, savedAt: 'old-time' } } }));
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('old', { file });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(loaded.revision, 7);
    assert.equal(loaded.savedAt, 'old-time');
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.deepEqual(loaded.settings, imported);
    const saved = saveAutomationSettings('old', loaded.settings, { file, revision: loaded.revision });
    assert.equal(saved.revision, 8);
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, imported);
    assert.equal(JSON.parse(fs.readFileSync(file)).version, SETTINGS_SCHEMA_VERSION);
    assert.throws(() => saveAutomationSettings('old', imported, { file, revision: 7 }), /其他页面更新/);
  });
  test('旧城战共享目标迁移到防守侧，保存与导入保留顺序及独立副本', () => {
    const settings = legacySettings();
    Object.assign(settings.cityWar, {
      enabled: true, fleetIds: ['1远征船', '2远征船'], defenceFleetIds: ['2远征船'],
      targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:3', '1:2'],
    });
    const before = structuredClone(settings);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { war: { settings, revision: 4 } } }));
    const bytes = fs.readFileSync(file);
    const stored = loadAutomationSettings('war', { file });
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(stored.settings, imported);
    assert.deepEqual(settings, before);
    for (const migrated of [stored.settings, imported]) {
      assert.equal(migrated.cityWar.defenceTargetMode, 'selected');
      assert.equal(migrated.cityWar.defenceTargetPriority, 'original');
      assert.deepEqual(migrated.cityWar.defenceCityRefs, ['1:3', '1:2']);
      assert.notEqual(migrated.cityWar.defenceCityRefs, migrated.cityWar.cityRefs);
      assert.deepEqual(migrateSettingsVersion(migrated, 1), migrated);
    }
    imported.cityWar.defenceCityRefs = ['1:3'];
    imported.cityWar.targetMode = 'alliance';
    imported.cityWar.targetPriority = 'fewestAllied';
    saveAutomationSettings('war', imported, { file, revision: stored.revision });
    assert.deepEqual(loadAutomationSettings('war', { file }).settings.cityWar, imported.cityWar);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(imported)).cityWar, imported.cityWar);
  });
  test('城战迁移逐项保留显式防守配置，非法值继续拒绝', () => {
    const settings = legacySettings();
    Object.assign(settings.cityWar, {
      targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:2'],
      defenceTargetMode: 'alliance', defenceCityRefs: [],
    });
    const document = { format: SETTINGS_FORMAT, version: 1, settings };
    const migrated = importAutomationSettings(document);
    assert.equal(migrated.cityWar.defenceTargetMode, 'alliance');
    assert.equal(migrated.cityWar.defenceTargetPriority, 'original');
    assert.deepEqual(migrated.cityWar.defenceCityRefs, []);
    for (const [field, value] of [['defenceTargetMode', null], ['defenceTargetPriority', 'unknown'], ['defenceCityRefs', undefined]]) {
      const invalid = structuredClone(document);
      invalid.settings.cityWar[field] = value;
      assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['cityWar.' + field]);
    }
  });
  test('超凡英雄旧设置保留既有选择并补全挑战与转盘字段', () => {
    const settings = legacySettings();
    settings.heroRaid = { enabled: true, orders: true, rewards: false };
    const expected = { enabled: true, challenge: false, retryTimes: 10, orders: true, lottery: false, rewards: false };
    const document = { format: SETTINGS_FORMAT, version: 1, settings };
    assert.deepEqual(importAutomationSettings(document).heroRaid, expected);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { raid: { settings, revision: 3 } } }));
    const original = fs.readFileSync(file);
    assert.deepEqual(loadAutomationSettings('raid', { file }).settings.heroRaid, expected);
    assert.deepEqual(fs.readFileSync(file), original);
    for (const [field, value] of [['challenge', 'true'], ['lottery', 1], ['retryTimes', -1], ['retryTimes', 101], ['retryTimes', 1.5], ['retryTimes', null]]) {
      const invalid = structuredClone(document);
      invalid.settings.heroRaid[field] = value;
      assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['heroRaid.' + field]);
    }
    for (const retryTimes of [0, 100]) {
      const valid = structuredClone(document);
      Object.assign(valid.settings.heroRaid, { challenge: true, lottery: true, retryTimes });
      assert.deepEqual(importAutomationSettings(valid).heroRaid, { ...expected, challenge: true, lottery: true, retryTimes });
    }
  });
  test('旧账号缺少详细设置时仍返回版本0且不会创建详细配置', () => {
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('legacy-native', { file });
    assert.equal(loaded.revision, 0);
    assert.deepEqual(loaded.settings, defaultSettings());
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
  test('严格导入继续拒绝原有必填字段缺失、非法值和未知字段', () => {
    const document = () => ({ format: SETTINGS_FORMAT, version: 1, settings: legacySettings() });
    const missing = document(); delete missing.settings.factory.produce;
    assert.throws(() => importAutomationSettings(missing), error => !!error.fields?.['factory.produce']);
    const invalid = document(); invalid.settings.factory.checkEverySeconds = undefined;
    assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['factory.checkEverySeconds']);
    const unknown = document(); unknown.settings.factory.removedField = true;
    assert.throws(() => importAutomationSettings(unknown), /不支持/);
  });
  test('版本24保留巨轮去程开关、阈值和预算，回城需主动启用', () => {
    for (const enabled of [true, false]) {
      const old = defaultSettings();
      Object.assign(old.treasure, { marchSpeedUp: enabled, marchTargetSeconds: 95, dailyDiamondLimit: 120 });
      for (const field of ['outboundSpeedUp', 'returnSpeedUp', 'returnTargetSeconds']) delete old.treasure[field];
      const { treasure } = importAutomationSettings({ format: SETTINGS_FORMAT, version: 24, settings: old });
      assert.deepEqual(treasure, { ...old.treasure, outboundSpeedUp: true, returnSpeedUp: false, returnTargetSeconds: 60 });
      Object.assign(treasure, { outboundSpeedUp: false, returnSpeedUp: true, returnTargetSeconds: 11 });
      assert.deepEqual(importAutomationSettings(exportAutomationSettings({ ...old, treasure })).treasure, treasure);
    }
  });
  test('版本25共享预算按原启用项分配，往返导入保留新额度', () => {
    const old = defaultSettings();
    delete old.treasure.returnDailyDiamondLimit;
    Object.assign(old.treasure, { returnSpeedUp: true, dailyDiamondLimit: 91 });
    old.silicon.dailyDiamondLimit = 101;
    for (const fleet of old.silicon.fleets) {
      for (const key of ['repairDailyDiamonds','marchDailyDiamonds','returnSpeedUp','returnTargetSeconds','returnDailyDiamonds','repairTargetSeconds']) delete fleet[key];
    }
    Object.assign(old.silicon.fleets[0], { enabled: true, repairSpeedUp: true, marchSpeedUp: true });
    Object.assign(old.silicon.fleets[1], { enabled: true, marchSpeedUp: true });
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 25, settings: old });
    assert.equal(migrated.treasure.dailyDiamondLimit, 46); assert.equal(migrated.treasure.returnDailyDiamondLimit, 45);
    assert.deepEqual(migrated.silicon.fleets.map(f => [f.repairDailyDiamonds, f.marchDailyDiamonds, f.returnDailyDiamonds]),
      [[undefined,34,0],[undefined,33,0],[undefined,0,0]]);
    assert.equal(migrated.silicon.fleets[0].returnSpeedUp, false);
    assert.equal(migrated.silicon.dailyDiamondLimit, undefined);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(migrated)), migrated);
    old.treasure.outboundSpeedUp = false;
    assert.equal(importAutomationSettings({ format: SETTINGS_FORMAT, version: 25, settings: old }).treasure.returnDailyDiamondLimit, 91);
  });
  test('版本26已存设置、导入及旧页面保存均移除硅矿维修加速，保留去回程与普通维修', () => {
    const expected = defaultSettings();
    Object.assign(expected.silicon.fleets[0], { enabled: true, autoRepair: true, marchSpeedUp: true,
      marchTargetSeconds: 80, marchDailyDiamonds: 70, returnSpeedUp: true, returnTargetSeconds: 45, returnDailyDiamonds: 120 });
    const old = structuredClone(expected);
    Object.assign(old.silicon.fleets[0], { repairSpeedUp: true, repairTargetSeconds: 40, repairDailyDiamonds: 300 });
    Object.assign(old.silicon.fleets[1], { repairSpeedUp: true, repairTargetSeconds: 10, repairDailyDiamonds: 1000 });
    fs.writeFileSync(file, JSON.stringify({ version: 26, accounts: { old: { settingsVersion: 26, revision: 1, settings: old } } }));
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, expected);
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 26, settings: old }), expected);
    assert.deepEqual(saveAutomationSettings('old', old, { file, revision: 1 }).settings, expected);
  });
  test('旧账号默认关闭两项提前召回，两项分钟数可独立往返保存', () => {
    const old = defaultSettings();
    for (const group of ['cityWar','treasure']) { delete old[group].recallSilicon; delete old[group].recallLeadMinutes; }
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 27, settings: old });
    for (const group of ['cityWar','treasure']) {
      assert.equal(migrated[group].recallSilicon, false);
      assert.equal(migrated[group].recallLeadMinutes, 5);
      for (const value of [0, 1441, 0.5, '10']) {
        assert.throws(() => validateSettings({ ...migrated, [group]: { ...migrated[group], recallLeadMinutes: value } }));
      }
    }
    Object.assign(migrated.cityWar, { recallSilicon: true, recallLeadMinutes: 8 });
    migrated.treasure.recallLeadMinutes = 3;
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(migrated)), migrated);
  });
  test('版本28旧配置加载、导入和保存时移除钓具预留金币', () => {
    const expected = defaultSettings();
    Object.assign(expected.gather, { enabled: true, upgradeFishing: true, targetLevel: 7 });
    expected.schedule.fishEnhance = true;
    const old = structuredClone(expected);
    old.gather.fishingGoldReserve = 10000;
    fs.writeFileSync(file, JSON.stringify({ version: 28, accounts: { old: { settingsVersion: 28, revision: 1, settings: old } } }));
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, expected);
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 28, settings: old }), expected);
    assert.deepEqual(saveAutomationSettings('old', old, { file, revision: 1 }).settings, expected);
  });
  test('版本30工事捐赠配置保留捐赠选择并补齐排除名单', () => {
    for (const materials of [[], ['耐火砖']]) {
      const expected = defaultSettings();
      Object.assign(expected.guildFort, { enabled: true, materials, reserve: 3, dailyLimit: 15 });
      expected.alliance.allowedMaterials = ['木板'];
      const old = structuredClone(expected);
      delete old.guildFort.blockedMaterials;
      fs.writeFileSync(file, JSON.stringify({ version: 30, accounts: { old: { settingsVersion: 30, revision: 1, settings: old } } }));
      assert.deepEqual(loadAutomationSettings('old', { file }).settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 30, settings: old }), expected);
    }
  });
  test('海盗独立开关迁移保留原来实际运行的动作', () => {
    for (const hunt of [false, true]) for (const sweep of [false, true]) for (const daily of [false, true]) {
      const old = defaultSettings();
      delete old.pirate;
      old.loop.dailies = old.dailies.enabled = daily;
      old.schedule.pirate = sweep;
      Object.assign(old.pirateHunt, { enabled: hunt, fleetIds: ['1远征船'] });
      const settings = importAutomationSettings({ format: SETTINGS_FORMAT, version: 31, settings: old });
      assert.equal(settings.pirate.enabled && settings.pirateHunt.enabled, hunt);
      assert.equal(settings.pirate.enabled && settings.schedule.pirate, sweep && daily);
      assert.deepEqual(settings.loop, old.loop);
      assert.deepEqual(settings.dailies, old.dailies);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), settings);
    }
  });
  test('版本32的巨轮配置默认关闭追杀及其加速，并能单独启用追杀', () => {
    const expected = defaultSettings(), old = structuredClone(expected);
    for (const key of ['chase', 'chaseNames', 'chaseSpeedUp', 'chaseTargetSeconds', 'chaseDailyDiamondLimit']) delete old.treasure[key];
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 32, settings: old }), expected);
    assert.equal(expected.treasure.chase, false);
    assert.equal(expected.treasure.chaseSpeedUp, false);
    Object.assign(expected.treasure, { enabled: true, chase: true, fleetIds: ['1远征船'] });
    assert.throws(() => exportAutomationSettings(expected), /完整昵称/);
    Object.assign(expected.treasure, { chaseNames: ['对手甲'], chaseSpeedUp: true, chaseDailyDiamondLimit: 75 });
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(expected)), expected);
  });
  test('版本33的追杀默认全天，多时段导出再导入保留并校验时间', () => {
    const old = defaultSettings();
    Object.assign(old.treasure, { enabled: true, chase: true, chaseNames: ['对手甲'], fleetIds: ['1远征船'] });
    delete old.treasure.chaseWindows;
    const settings = importAutomationSettings({ format: SETTINGS_FORMAT, version: 33, settings: old });
    assert.deepEqual(settings.treasure, { ...old.treasure, chaseWindows: [] });
    settings.treasure.chaseWindows = ['22:00-02:00', '08:00-09:00'];
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), settings);
    for (const bad of ['24:00-02:00', '08:00-08:60', '8:00', '08:00-']) {
      settings.treasure.chaseWindows = [bad];
      assert.throws(() => exportAutomationSettings(settings), error => !!error.fields['treasure.chaseWindows']);
    }
  });
  test('版本34的用券单抽在读取、导入和旧页面保存时移除，保留免费招募选择', () => {
    const expected = defaultSettings();
    expected.schedule.freeRecruit = true;
    const old = structuredClone(expected);
    old.schedule.ticketRecruit = true;
    fs.writeFileSync(file, JSON.stringify({ version: 34, accounts: { old: { settingsVersion: 34, revision: 1, settings: old } } }));
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, expected);
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 34, settings: old }), expected);
    assert.deepEqual(saveAutomationSettings('old', old, { file, revision: 1 }).settings, expected);
    assert(!Object.hasOwn(nativeTaskValues(expected, old.schedule), 'ticketRecruit'));
  });
  test('旧商船配置只补齐缺失的钻石选项，原文件、显式值和校验保持有效', () => {
    const settings = defaultSettings();
    settings.guildShip.enabled = true;
    const old = structuredClone(settings);
    delete old.guildShip.allowDiamonds;
    delete old.guildShip.diamondDailyLimit;
    for (const version of [32, 35]) {
      const bytes = JSON.stringify({ version, accounts: { old: { settingsVersion: version, revision: 180, settings: old } } });
      fs.writeFileSync(file, bytes);
      const loaded = loadAutomationSettings('old', { file });
      assert.deepEqual(loaded.settings, settings);
      assert.equal(loaded.revision, 180);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: old }), settings);
    }
    const document = { format: SETTINGS_FORMAT, version: 35, settings: old };
    old.guildShip.diamondDailyLimit = 17;
    assert.equal(importAutomationSettings(document).guildShip.diamondDailyLimit, 17);
    old.guildShip.allowDiamonds = true;
    assert.deepEqual(importAutomationSettings(document).guildShip, old.guildShip);
    old.guildShip.diamondDailyLimit = -1;
    assert.throws(() => importAutomationSettings(document), error => !!error.fields['guildShip.diamondDailyLimit']);
  });
  test('版本36巨轮默认全天参与，保留已有追杀时段，校验并保存多段参与时间', () => {
    const old = defaultSettings();
    old.treasure.chaseWindows = ['22:00-02:00'];
    delete old.treasure.windows;
    const bytes = JSON.stringify({ version: 36, accounts: { old: { settingsVersion: 36, revision: 2, settings: old } } });
    fs.writeFileSync(file, bytes);
    const settings = loadAutomationSettings('old', { file }).settings;
    assert.deepEqual(settings.treasure, { ...old.treasure, windows: [] });
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 36, settings: old }), settings);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    settings.treasure.windows = ['08:00-12:00', '23:00-01:00'];
    saveAutomationSettings('old', settings, { file, revision: 2 });
    assert.deepEqual(loadAutomationSettings('old', { file }).settings, settings);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), settings);
    for (const bad of [['08:00-24:01'], ['8:00-09:00'], ['08:00-09:00', '08:00-09:00'], '08:00-09:00']) {
      settings.treasure.windows = bad;
      assert.throws(() => exportAutomationSettings(settings), error => !!error.fields['treasure.windows']);
    }
  });
  test('竞技场旧共享次数按开关分配，单项停用和零次数可往返保存', () => {
    for (const fallback of [false, true]) for (const limit of [0, 1, 5]) {
      const old = defaultSettings();
      old.schedule.arena = true;
      old.arena = { dailyBattleLimit: limit, fallbackLowerRank: fallback, target: 'rank', maxPowerRatio: 70, claimTask: true };
      const settings = importAutomationSettings({ format: SETTINGS_FORMAT, version: 37, settings: old });
      const sweeps = fallback ? Math.floor(limit / 2) : 0;
      assert.deepEqual(settings.arena, { challengeHigher: true, challengeLimit: limit - sweeps,
        target: 'rank', maxPowerRatio: 70, fallbackWeakest: false, sweepLower: fallback, sweepLimit: fallback ? sweeps : 3, claimTask: true });
      assert.deepEqual(validateSettings(old), settings);
      settings.arena.challengeHigher = false;
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), settings);
    }
  });
  test('版本38竞技场默认关闭超限兜底，显式开启后可保存导出', () => {
    const old = defaultSettings();
    delete old.arena.fallbackWeakest;
    const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 38, settings: old });
    assert.equal(upgraded.arena.fallbackWeakest, false);
    assert.deepEqual(validateSettings(old), upgraded);
    upgraded.arena.fallbackWeakest = true;
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(upgraded)), upgraded);
  });
  test('版本39生产配置默认允许收取，按类型保存的禁止名单可导出导入', () => {
    const old = defaultSettings();
    delete old.factory.blockedCollectionTypes;
    const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 39, settings: old });
    assert.deepEqual(upgraded.factory.blockedCollectionTypes, []);
    assert.deepEqual(validateSettings(old), upgraded);
    upgraded.factory.blockedCollectionTypes = ['精铁厂', '训练营'];
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(upgraded)), upgraded);
  });
  test('版本41折扣商店移除刷新限制，保留总开关和既有购买规则', () => {
    const expected = defaultSettings();
    expected.schedule.shop = true;
    expected.discountShop.rules = [{ id: '建筑蓝图', maxPercent: 50, maxDiamonds: 30 }];
    const old = structuredClone(expected);
    delete old.discountShop.fallbackCheapest;
    Object.assign(old.discountShop, { refreshLimit: 3, maxRefreshCost: 50 });
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 41, settings: old }), expected);
    assert.deepEqual(validateSettings(old), expected);
    const shopFile = path.join(directory, 'discount-shop.json');
    fs.writeFileSync(shopFile, JSON.stringify({ version: 41, accounts: { shop: { settingsVersion: 41, revision: 1, settings: old } } }));
    assert.deepEqual(loadAutomationSettings('shop', { file: shopFile }).settings, expected);
    old.discountShop.extra = true;
    assert.throws(() => validateSettings(old), error => !!error.fields?.['discountShop.extra']);
  });
  test('加载、导入和旧页面保存时移除首杀种类与等级上限，保留免费扫荡目标', () => {
    const expected = defaultSettings();
    expected.pirate.enabled = expected.schedule.pirate = true;
    expected.pirateSweep = { types: ['2'], times1: 1, times2: -1, times3: 1 };
    Object.assign(expected.pirateHunt, { enabled: true, maxFailures: 4, fleetIds: ['1远征船'] });
    for (const version of [45, 46, 47]) {
      const old = structuredClone(expected);
      old.pirateSweep = { type: '2' };
      if (version < 47) old.pirateHunt.types = ['3'];
      if (version === 45) old.pirateHunt.maxLevel = 12;
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { pirate: { settingsVersion: version, revision: 3, settings: old } } }));
      assert.deepEqual(loadAutomationSettings('pirate', { file }).settings, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: old }), expected);
      const saved = saveAutomationSettings('pirate', old, { file, revision: 3 });
      assert.deepEqual(exportAutomationSettings(saved.settings).settings, expected);
      assert.deepEqual(old.pirateSweep, { type: '2' });
    }
  });
  test('主线第46版和海盗第48版配置分别升级后保留积分赛与扫荡选择', () => {
    const expected = defaultSettings();
    expected.league.dailyBattleLimit = 7;
    expected.pirateSweep = { types: ['2'], times1: 1, times2: -1, times3: 1 };
    const main = structuredClone(expected);
    Object.assign(main.pirateHunt, { types: ['1'], maxLevel: 12 });
    main.pirateSweep = { type: '2' };
    const pirates = structuredClone(expected);
    Object.assign(pirates.league, { target: 'score', fallbackWeakest: true });
    for (const [version, settings] of [[46, main], [48, pirates]]) {
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }), expected);
      assert.deepEqual(migrateSettingsVersion(settings, version), expected);
    }
  });
  test('VIP 只保存总开关，旧配置保留总开关选择，原生任务兼容任一领奖开关', () => {
    for (const vip of [true, false]) {
      for (const vipDaily of [true, false]) {
        for (const vipDailyGift of [true, false]) {
          const old = defaultSettings();
          old.activityAutomation.vip = vip;
          Object.assign(old.schedule, { vipDaily, vipDailyGift });
          const restored = importAutomationSettings({ format: SETTINGS_FORMAT, version: 49, settings: old });
          assert.deepEqual(restored, validateSettings(old));
          assert.equal(restored.activityAutomation.vip, vip);
          assert(!Object.hasOwn(restored.schedule, 'vipDaily'));
          assert(!Object.hasOwn(restored.schedule, 'vipDailyGift'));
          const tasks = nativeTaskValues(restored, old.schedule);
          assert.equal(tasks.vipDaily, vip);
          assert(!Object.hasOwn(tasks, 'vipDailyGift'));
          const native = { vipDaily, vipDailyGift };
          assert.equal(settingsFromNative(native).activityAutomation.vip, vipDaily || vipDailyGift);
          delete old.activityAutomation;
          assert.equal(importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old }).activityAutomation.vip, vipDaily || vipDailyGift);
        }
      }
    }
  });
  test('旧账号默认新版排产，模拟原生策略及主产物可完整导入导出', () => {
    const old = defaultSettings();
    delete old.factory.strategy;
    delete old.factory.simulatedTargets;
    const updated = importAutomationSettings({format:SETTINGS_FORMAT,version:55,settings:old});
    assert.equal(updated.factory.strategy,'smart');
    Object.assign(updated.factory,{strategy:'nativeSimulation',simulatedTargets:['氧气瓶','铜锭']});
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(updated)).factory,updated.factory);
    updated.factory.strategy='invalid';
    assert.throws(()=>validateSettings(updated),error=>!!error.fields?.['factory.strategy']);
  });
  test('第50版旧存档可读取、导入和保存，满舱航线只在缺项时补齐', () => {
    // 固定旧版导出样本。用当前默认值构造旧存档会掩盖下次新增必填项时遗漏的迁移。
    const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/automation-settings-v50.json', import.meta.url), 'utf8'));
    for (const value of [undefined, false, true]) {
      const document = structuredClone(legacy);
      if (value !== undefined) document.settings.merchant.fullCargoRoutes = value;
      const expected = structuredClone(document.settings);
      delete expected.merchant.speedUpMinProfit;
      expected.merchant.speedUpMode = 'deadline';
      expected.merchant.fullCargoRoutes = value ?? defaultSettings().merchant.fullCargoRoutes;
      expected.treasure.chasePlayerIds = [];
      expected.alliance.memberIds = [];
      Object.assign(expected.factory,{strategy:'smart',simulatedTargets:[]});
      for (const fleet of expected.silicon.fleets) Object.assign(fleet, { huntPlayerIds: [], safePlayerIds: [] });
      const entry = { settingsVersion: document.version, revision: 7, settings: document.settings };
      fs.writeFileSync(file, JSON.stringify({ version: document.version, accounts: { merchant: entry, other: entry } }));
      const bytes = fs.readFileSync(file);
      const loaded = loadRecoverableAutomationSettings('merchant', { file, expected: true });
      assert.equal(loaded.recovery, undefined);
      assert.equal(loaded.revision, entry.revision);
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(importAutomationSettings(document), expected);
      assert.deepEqual(fs.readFileSync(file), bytes);
      saveAutomationSettings('merchant', loaded.settings, { file, revision: loaded.revision });
      const saved = JSON.parse(fs.readFileSync(file));
      assert.equal(saved.accounts.merchant.settingsVersion, SETTINGS_SCHEMA_VERSION);
      assert.deepEqual(saved.accounts.other, entry);
      assert.deepEqual(loadAutomationSettings('merchant', { file }).settings, expected);
    }
    const invalid = structuredClone(legacy);
    invalid.settings.merchant.fullCargoRoutes = 'false';
    assert.throws(() => importAutomationSettings(invalid), error => !!error.fields?.['merchant.fullCargoRoutes']);
  });
  test('第51版自设指针收益门槛可从存档、导出文件和旧页面草稿中移除', () => {
    const expected = defaultSettings();
    Object.assign(expected.merchant, { autoSpeedUp: true, keepPointers: 3, dailyPointerLimit: 8,
      minExpectedProfit: 120, autoBuyPointers: false });
    const old = structuredClone(expected);
    old.merchant.speedUpMinProfit = 20000;
    fs.writeFileSync(file, JSON.stringify({ version: 51, accounts: { ship: { settingsVersion: 51, settings: old, revision: 5 } } }));
    const loaded = loadRecoverableAutomationSettings('ship', { file, expected: true });
    assert.equal(loaded.recovery, undefined);
    assert.deepEqual(loaded.settings, expected);
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 51, settings: old }), expected);
    const saved = saveAutomationSettings('ship', old, { file, revision: loaded.revision });
    assert.equal(saved.revision, 6);
    assert.deepEqual(exportAutomationSettings(saved.settings).settings, expected);
    assert.equal(old.merchant.speedUpMinProfit, 20000);
  });
  test('第52版周转策略迁为稳定模式，读取、导入和旧页面保存保留其他选项', () => {
    for (const mode of ['profit', 'deadline', 'refresh', 'arrival', 'race', 'full']) {
      for (const autoSpeedUp of [false, true]) {
        const old = defaultSettings();
        Object.assign(old.merchant, { speedUpMode: mode, autoSpeedUp, autoBuyPointers: !autoSpeedUp,
          dailyPointerLimit: 7, speedUpMaxPerLeg: 2, keepPointers: 3 });
        const expected = structuredClone(old);
        if (mode === 'profit') expected.merchant.speedUpMode = 'deadline';
        const entry = { revision: 4, settingsVersion: 52, settings: old };
        fs.writeFileSync(file, JSON.stringify({ version: 52, accounts: { ship: entry } }));
        const loaded = loadAutomationSettings('ship', { file });
        assert.equal(loaded.revision, 4);
        assert.deepEqual(loaded.settings, expected);
        assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 52, settings: old }), expected);
        assert.deepEqual(saveAutomationSettings('ship', old, { file, revision: loaded.revision }).settings, expected);
      }
    }
  });
  test('53 版攻击名单保留原昵称，角色 ID 独立保存、导入及校验', () => {
    const old = defaultSettings(), role = '9007199254740995';
    old.treasure.chase = true;
    old.treasure.chaseNames = ['12345'];
    delete old.treasure.chasePlayerIds;
    for (const fleet of old.silicon.fleets) {
      Object.assign(fleet, { huntEnabled: true, huntPlayers: ['原目标'], safePlayers: ['原盟友'] });
      delete fleet.huntPlayerIds;
      delete fleet.safePlayerIds;
    }
    const settings = importAutomationSettings({ format: SETTINGS_FORMAT, version: 53, settings: old });
    assert.deepEqual(settings.treasure.chaseNames, ['12345']);
    assert.deepEqual(settings.treasure.chasePlayerIds, []);
    assert.deepEqual(settings.silicon.fleets[0].safePlayers, ['原盟友']);
    assert.deepEqual(settings.silicon.fleets[0].huntPlayers, ['原目标']);
    Object.assign(settings.treasure, { chaseNames: [], chasePlayerIds: [role] });
    Object.assign(settings.silicon.fleets[0], { huntPlayers: [], huntPlayerIds: [role], safePlayerIds: ['9223372036854775807'] });
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), settings);
    for (const target of [settings.treasure.chasePlayerIds, settings.silicon.fleets[0].huntPlayerIds, settings.silicon.fleets[0].safePlayerIds]) {
      for (const value of ['9223372036854775808', '1e15', '01', 123, target[0]]) {
        target.push(value);
        assert.throws(() => exportAutomationSettings(settings));
        target.pop();
      }
    }
  });
  test('54 版联盟帮助保留昵称关键词，新名单以完整角色 ID 往返保存', () => {
    const old = defaultSettings();
    delete old.alliance.memberIds;
    old.alliance.memberKeywords = ['原关键词'];
    const settings = importAutomationSettings({ format: SETTINGS_FORMAT, version: 54, settings: old });
    assert.deepEqual(settings.alliance.memberIds, []);
    assert.deepEqual(settings.alliance.memberKeywords, ['原关键词']);
    settings.alliance.memberIds = ['9007199254740995'];
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)).alliance, settings.alliance);
    settings.alliance.memberIds = ['9e15'];
    assert.throws(() => validateSettings(settings), error => !!error.fields['alliance.memberIds']);
  });
  test('版本1升级后重复迁移保持一致，保留有效的用户值', () => {
    assert.equal(SETTINGS_SCHEMA_VERSION, 56);
    const settings = legacySettings();
    settings.factory.checkEverySeconds = 270;
    settings.resources.diamondDailyLimit = 1234;
    const before = structuredClone(settings);
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings });
    assert.equal(migrated.factory.checkEverySeconds, 270);
    assert.equal(migrated.resources.diamondDailyLimit, 1234);
    assert.deepEqual(settings, before);
    assert.deepEqual(migrateSettingsVersion(migrated, 2), migrated);
    const exported = exportAutomationSettings(migrated);
    assert.equal(exported.version, SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(importAutomationSettings(exported), migrated);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(importAutomationSettings(exported))), migrated);
  });
  test('旧配置和已打开的页面移除六项锻造与套装限制，保留其他选择', () => {
    const expected = defaultSettings();
    Object.assign(expected.forge, { universal: true, universalReserve: 8, recipeIds: ['1001'] });
    Object.assign(expected.antique, { suit: true, suitQualities: ['BLUE'] });
    const old = structuredClone(expected);
    Object.assign(old.forge, { goldReserve: 50, materialReserve: 20, dailyLimit: 1, dailyGoldLimit: 100 });
    Object.assign(old.antique, { goldReserve: 80, dailyGoldLimit: 60 });
    const document = { format: SETTINGS_FORMAT, version: 18, settings: old };
    assert.deepEqual(importAutomationSettings(document), expected);
    fs.writeFileSync(file, JSON.stringify({ version: 18, accounts: { test: { settingsVersion: 18, revision: 7, settings: old } } }));
    assert.deepEqual(loadAutomationSettings('test', { file }).settings, expected);
    const saved = saveAutomationSettings('test', old, { file, revision: 7 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.test.settings, expected);
    assert.deepEqual(exportAutomationSettings(saved.settings).settings, expected);
  });
  test('旧货轮奖励列表沿用任一命中，三组方式和门槛独立保存', () => {
    const old = defaultSettings();
    old.treasure.rewardItems = ['精铁', 'GOLD'];
    const prefixes = ['reward', 'fallbackMediumReward', 'fallbackSmallReward'];
    for (const prefix of prefixes) {
      delete old.treasure[prefix + 'MatchMode'];
      delete old.treasure[prefix + 'MinHits'];
    }
    fs.writeFileSync(file, JSON.stringify({ version: 20, accounts: { test: { settingsVersion: 20, revision: 1, settings: old } } }));
    const loaded = loadAutomationSettings('test', { file }).settings;
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 20, settings: old }), loaded);
    assert.deepEqual(loaded.treasure.rewardItems, old.treasure.rewardItems);
    for (const prefix of prefixes) {
      assert.equal(loaded.treasure[prefix + 'MatchMode'], 'any');
      assert.equal(loaded.treasure[prefix + 'MinHits'], 2);
      for (const [key, value] of [['MatchMode', 'invalid'], ['MinHits', 0], ['MinHits', 1.5], ['MinHits', 101]]) {
        const invalid = structuredClone(loaded);
        invalid.treasure[prefix + key] = value;
        assert.throws(() => validateSettings(invalid), e => !!e.fields?.['treasure.' + prefix + key]);
      }
    }
    Object.assign(loaded.treasure, { rewardMatchMode: 'multiple', rewardMinHits: 3, fallbackMediumRewardMatchMode: 'all' });
    saveAutomationSettings('test', loaded, { file, revision: 1 });
    assert.deepEqual(loadAutomationSettings('test', { file }).settings, loaded);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(loaded)), loaded);
  });
  test('旧硅矿等级按舰队迁移为多选，空选可以保存和导入', () => {
    const old = defaultSettings(), levels = ['PURPLE', 'BLUE', 'ORANGE'];
    old.silicon.fleets.forEach((fleet, index) => { delete fleet.tiers; fleet.tier = levels[index]; });
    fs.writeFileSync(file, JSON.stringify({ version: 19, accounts: { test: { settingsVersion: 19, revision: 1, settings: old } } }));
    const loaded = loadAutomationSettings('test', { file }).settings;
    assert.deepEqual(loaded.silicon.fleets.map(fleet => fleet.tiers), levels.map(tier => [tier]));
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 19, settings: old }), loaded);
    assert.deepEqual(validateSettings(old), loaded);
    loaded.silicon.fleets[1].tiers = [];
    const saved = saveAutomationSettings('test', loaded, { file, revision: 1 });
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), loaded);
  });
  test('旧货轮开关迁移为类型多选，保留兜底和显式空选', () => {
    const all = ['ORANGE', 'PURPLE', 'BLUE'];
    assert.deepEqual(defaultSettings().treasure.qualities, all);
    for (const version of [1, 15]) for (const flag of [true, false, undefined]) {
      const old = defaultSettings();
      delete old.treasure.qualities;
      if (flag !== undefined) old.treasure.onlyTenThousand = flag;
      Object.assign(old.treasure, { fallbackEnabled: true, fallbackQualities: ['BLUE'] });
      const expected = { ...old.treasure, qualities: flag ? ['ORANGE'] : all };
      delete expected.onlyTenThousand;
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { test: { settingsVersion: version, revision: 7, settings: old } } }));
      const before = fs.readFileSync(file);
      const loaded = loadAutomationSettings('test', { file });
      assert.deepEqual(loaded.settings.treasure, expected);
      assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: old }).treasure, expected);
      assert.deepEqual(fs.readFileSync(file), before);
      const saved = saveAutomationSettings('test', loaded.settings, { file, revision: 7 });
      assert.deepEqual(loadAutomationSettings('test', { file }).settings.treasure, expected);
      assert.deepEqual(exportAutomationSettings(saved.settings).settings.treasure, expected);
      if (flag !== undefined) assert.deepEqual(validateSettings(old).treasure, expected, '已打开的旧版页面可以保存');
    }
    const both = defaultSettings();
    Object.assign(both.treasure, { onlyTenThousand: false, qualities: [] });
    assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 15, settings: both }).treasure.qualities, []);
    both.treasure.onlyTenThousand = 'false';
    assert.throws(() => validateSettings(both), error => !!error.fields?.['treasure.onlyTenThousand']);
  });
  test('保存一个账号不会将未迁移的其他账号误标为当前版本', () => {
    const old = { revision: 8, savedAt: 'legacy-time', settings: legacySettings() };
    const other = { revision: 12, savedAt: 'other-time', settings: legacySettings() };
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { old, other } }));
    const otherBefore = loadAutomationSettings('other', { file });
    const loaded = loadAutomationSettings('old', { file });
    const saved = saveAutomationSettings('old', loaded.settings, { file, revision: loaded.revision });
    const store = JSON.parse(fs.readFileSync(file));
    assert.equal(store.version, SETTINGS_SCHEMA_VERSION);
    assert.equal(store.accounts.old.settingsVersion, SETTINGS_SCHEMA_VERSION);
    assert.equal(store.accounts.old.revision, 9);
    assert.deepEqual(store.accounts.other, other);
    assert.deepEqual(loadAutomationSettings('other', { file }), otherBefore);
    assert.deepEqual(loadAutomationSettings('old', { file }), saved);
    const bytes = fs.readFileSync(file);
    assert.throws(() => saveAutomationSettings('old', loaded.settings, { file, revision: 8 }), /其他页面更新/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    saveAutomationSettings('other', otherBefore.settings, { file, revision: otherBefore.revision });
    assert.equal(JSON.parse(fs.readFileSync(file)).accounts.other.settingsVersion, SETTINGS_SCHEMA_VERSION);
  });
  test('旧配置升级后连续保存只递增revision，格式版本不随保存次数增长', () => {
    for (const version of [43, 44, SETTINGS_SCHEMA_VERSION]) {
      const settings = defaultSettings();
      if (version === 43) Object.assign(settings.merchant, { upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300 });
      if (version < 45) delete settings.merchant.guardLastPointer;
      const other = { revision: 901, settingsVersion: version, settings: defaultSettings() };
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        account: { revision: 244, settingsVersion: version, settings }, other,
      } }));
      for (let count = 1; count <= 40; count++) {
        const loaded = loadAutomationSettings('account', { file });
        assert.equal(loaded.settings.merchant.guardLastPointer, false);
        assert.equal(loaded.revision, 244 + count - 1);
        const edited = structuredClone(loaded.settings); edited.loop.everySeconds = 30 + count;
        const saved = saveAutomationSettings('account', edited, { file, revision: loaded.revision });
        assert.equal(saved.revision, 244 + count);
        const bytes = fs.readFileSync(file), store = JSON.parse(bytes);
        assert.equal(store.version, SETTINGS_SCHEMA_VERSION, '文件格式编号不能随保存次数增长');
        assert.equal(store.accounts.account.settingsVersion, SETTINGS_SCHEMA_VERSION, '账号格式编号不能使用revision');
        assert.deepEqual(store.accounts.other, other, '保存不改其他账号的格式和修订号');
        assert.equal(exportAutomationSettings(saved.settings).version, SETTINGS_SCHEMA_VERSION);
        assert.deepEqual(loadAutomationSettings('account', { file }), saved, '重新读取保持保存值和修订号');
        assert.deepEqual(fs.readFileSync(file), bytes, '读取不能改变格式版本或修订号');
      }
      const bytes = fs.readFileSync(file);
      assert.throws(() => saveAutomationSettings('account', defaultSettings(), { file, revision: 244 }), /其他页面更新/);
      assert.deepEqual(fs.readFileSync(file), bytes, '过期修订号仍拒绝覆盖');
    }
  });
  test('当前版本缺项不能借历史迁移静默补全，旧版部分设置仍兼容', () => {
    for (const version of [2, 3, SETTINGS_SCHEMA_VERSION]) for (const remove of [
      settings => { delete settings.login; },
      settings => { delete settings.factory.checkEverySeconds; },
      settings => { delete settings.cityWar.fleetStrategies; },
      settings => { delete settings.cityWar.defenceTargetMode; },
    ]) {
      const settings = defaultSettings(); remove(settings);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }), /缺少/);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version, settings }, { partial: true }), /缺少/);
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { current: { settingsVersion: version, revision: 2, settings } } }));
      const bytes = fs.readFileSync(file);
      assert.throws(() => loadAutomationSettings('current', { file }), /缺少/);
      assert.deepEqual(fs.readFileSync(file), bytes);
    }
    const settings = { loop: { everySeconds: 37 } };
    fs.writeFileSync(file, JSON.stringify({ version: 2, accounts: { legacy: { revision: 3, settings } } }));
    const migrated = loadAutomationSettings('legacy', { file }).settings;
    assert.equal(migrated.loop.everySeconds, 37);
    assert.deepEqual(migrated, validateSettings(settings, { partial: true }));
    assert.equal(migrated.factory.checkEverySeconds, defaultSettings().factory.checkEverySeconds);
  });
  test('更高合法版本先校验内容，完整兼容的配置可迁移导入且不修改输入', () => {
    const settings = defaultSettings();
    settings.resources.diamondDailyLimit = 4321;
    settings.treasure.followMode = 'eachTime';
    settings.loop.everySeconds = 91;
    for (const version of [SETTINGS_SCHEMA_VERSION + 1, SETTINGS_SCHEMA_VERSION + 100, Number.MAX_SAFE_INTEGER]) {
      const document = { format: SETTINGS_FORMAT, version, settings: structuredClone(settings) };
      const before = structuredClone(document);
      assert.deepEqual(migrateSettingsVersion(document.settings, version), settings);
      assert.deepEqual(importAutomationSettings(document), settings);
      assert.deepEqual(document, before, '高版本兼容验证不修改输入');
      fs.writeFileSync(file, JSON.stringify({ version, accounts: { newer: {
        settingsVersion: version, revision: 4, settings: structuredClone(settings), metadata: { writer: 'future' },
      } } }));
      const bytes = fs.readFileSync(file), loaded = loadAutomationSettings('newer', { file });
      assert.deepEqual(loaded.settings, settings); assert.deepEqual(fs.readFileSync(file), bytes);
      const saved = saveAutomationSettings('newer', loaded.settings, { file, revision: 4 });
      const store = JSON.parse(fs.readFileSync(file));
      assert.equal(store.version, version); assert.equal(store.accounts.newer.settingsVersion, version);
      assert.deepEqual(store.accounts.newer.metadata, { writer: 'future' });
      assert.deepEqual(saved.settings, settings);
    }
  });
  test('高版本导入报告不兼容字段，未知字段与有损规范化均不能静默丢弃', () => {
    const version = SETTINGS_SCHEMA_VERSION + 1;
    for (const [field, mutate] of [
      ['factory.newerRule', settings => { settings.factory.newerRule = true; }],
      ['resources.diamondDailyLimit', settings => { settings.resources.diamondDailyLimit = -1; }],
      ['treasure.petrolReserve', settings => { settings.treasure.petrolReserve = 100; }],
      ['fleetSpeed.fleets.0.repairMaxDiamonds', settings => { settings.fleetSpeed.fleets[0].repairMaxDiamonds = 7; }],
      ['lineups.presets.0.name', settings => { settings.lineups.presets = [{ id: 'one', name: ' 测试阵容 ',
        formation: { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' } }]; }],
    ]) {
      const document = { format: SETTINGS_FORMAT, version, settings: defaultSettings() }; mutate(document.settings);
      const before = structuredClone(document);
      assert.throws(() => importAutomationSettings(document), error => {
        assert.equal(error.code, 'SETTINGS_INCOMPATIBLE');
        assert.equal(error.settingsVersion, version); assert.equal(error.supportedVersion, SETTINGS_SCHEMA_VERSION);
        assert(error.fields?.[field], '缺少具体字段诊断：' + field);
        assert(error.message.includes(field)); assert(error.message.includes(String(version)));
        assert(error.message.includes(String(SETTINGS_SCHEMA_VERSION)));
        return true;
      });
      assert.deepEqual(document, before);
    }
  });
  test('非法版本值与损坏文件拒绝写入，保留原文件', () => {
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '2', null]) {
      assert.throws(() => migrateSettingsVersion(defaultSettings(), version), /版本不支持/);
      assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version, settings: defaultSettings() }), /版本/);
    }
    for (const content of ['{broken', JSON.stringify({ version: 0, accounts: {} }),
      JSON.stringify({ version: 2, accounts: { old: { settingsVersion: '15', revision: 0, settings: defaultSettings() } } }),
      JSON.stringify({ version: 2, accounts: { other: { settingsVersion: 1.5, revision: 0, settings: defaultSettings() } } }),
    ]) {
      fs.writeFileSync(file, content);
      assert.throws(() => loadAutomationSettings('old', { file }));
      assert.throws(() => saveAutomationSettings('old', defaultSettings(), { file, revision: 0 }));
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  });
  console.log(`设置版本迁移验证通过 ${passed} 项。`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
