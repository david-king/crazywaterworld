// Synthetic files only: recovery must never touch real account settings or usage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-recovery-'));
process.env.CW_DATA_DIR = directory;
const { SETTINGS_SCHEMA_VERSION, defaultSettings, loadAutomationSettings,
  loadRecoverableAutomationSettings, saveAutomationSettings } = await import('../src/automation-settings.mjs');
const moduleUrl = new URL('../src/automation-settings.mjs', import.meta.url).href;
let passed = 0, sequence = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const fixture = () => {
  const dir = path.join(directory, String(++sequence)); fs.mkdirSync(dir);
  return { dir, file: path.join(dir, 'automation-settings.json') };
};
const record = (revision = 4) => ({ revision, savedAt: '2026-11-18T00:00:00.000Z', settingsVersion: SETTINGS_SCHEMA_VERSION, settings: defaultSettings() });
const store = accounts => ({ version: SETTINGS_SCHEMA_VERSION, accounts });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const backups = dir => fs.readdirSync(dir).filter(name => name.includes('.corrupt-') && name.endsWith('.bak'));
const recover = file => loadRecoverableAutomationSettings('a', { file, expected: true });

try {
  await test('未配置新账号保持revision0，不创建文件或锁目录', () => {
    const { dir, file } = fixture();
    assert.equal(loadRecoverableAutomationSettings('a', { file }).revision, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
    const valid = store({ other: record() }); write(file, valid); const bytes = fs.readFileSync(file);
    assert.equal(loadRecoverableAutomationSettings('a', { file }).revision, 0);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('已配置账号缺文件时恢复关闭默认值，重启重复读取不再恢复', () => {
    const { dir, file } = fixture(), result = recover(file);
    assert.equal(result.revision, 1); assert.deepEqual(result.settings, defaultSettings());
    assert.equal(result.recovery.required, true); assert.equal(result.recovery.reason, 'missing');
    assert.match(result.recovery.message, /重新配置/); assert.equal(result.recovery.backupFile, undefined);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(recover(file), result); assert.deepEqual(loadAutomationSettings('a', { file }), result);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('已配置账号条目缺失时备份文件并完整保留其他账号', () => {
    const { dir, file } = fixture(), other = record(7); other.settings.resources.diamondDailyLimit = 4321;
    write(file, store({ other })); const bytes = fs.readFileSync(file), result = recover(file);
    assert.equal(result.recovery.reason, 'missing'); assert.equal(backups(dir).length, 1);
    assert.deepEqual(fs.readFileSync(result.recovery.backupFile), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.other, other);
  });

  await test('非法JSON保留原始字节备份，严格读取仍报错，用量账本不变', () => {
    const { dir, file } = fixture(), original = Buffer.from('\ufeff{"accounts": {"a":  [broken\r\n');
    const usage = path.join(dir, 'automation-usage.json'), usageBytes = Buffer.from('{"reserved":120,"unknown":true}\n');
    fs.writeFileSync(file, original); fs.writeFileSync(usage, usageBytes);
    assert.throws(() => loadAutomationSettings('a', { file }));
    const result = recover(file); assert.equal(result.recovery.reason, 'corrupt');
    assert.equal(backups(dir).length, 1); assert.deepEqual(fs.readFileSync(result.recovery.backupFile), original);
    assert.deepEqual(result.settings, defaultSettings()); assert.deepEqual(fs.readFileSync(usage), usageBytes);
  });

  await test('单账号字段损坏只重置该账号并递增revision', () => {
    const { dir, file } = fixture(), bad = record(8), other = record(11);
    bad.settings.resources.allowDiamonds = 'invalid'; other.settings.resources.diamondDailyLimit = 4567;
    write(file, store({ a: bad, other })); const bytes = fs.readFileSync(file), result = recover(file);
    assert.equal(result.revision, 9); assert.equal(result.recovery.reason, 'corrupt');
    assert.deepEqual(result.settings, defaultSettings()); assert.equal(backups(dir).length, 1);
    assert.deepEqual(fs.readFileSync(result.recovery.backupFile), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.other, other);
  });

  await test('容器结构损坏可保留可读取的其他账号，损坏条目也标为待重配', () => {
    const { file } = fixture(), other = record(6);
    write(file, { accounts: { a: record(3), other, broken: null } });
    const result = recover(file), saved = JSON.parse(fs.readFileSync(file));
    assert.equal(result.revision, 4); assert.equal(result.recovery.reason, 'corrupt');
    assert.deepEqual(saved.accounts.other, other); assert.equal(saved.accounts.broken.recovery.required, true);
    assert.equal(loadAutomationSettings('broken', { file }).recovery.required, true);
    assert.equal(loadAutomationSettings('other', { file }).revision, 6);
  });

  await test('其他账号条目头损坏不重置正常当前账号', () => {
    const { dir, file } = fixture(), good = record(9); good.settings.resources.diamondDailyLimit = 8765;
    write(file, store({ a: good, broken: null }));
    const result = recover(file), saved = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(saved.accounts.a, good); assert.equal(result.recovery, undefined); assert.equal(result.revision, 9);
    assert.equal(saved.accounts.broken.recovery.required, true); assert.equal(backups(dir).length, 1);
    assert.deepEqual(recover(file), result); assert.equal(backups(dir).length, 1);
  });

  await test('恢复标记跨读取保留，合法保存才清除并继续递增revision', () => {
    const { file } = fixture(); write(file, store({ a: null }));
    const result = recover(file); assert.equal(result.recovery.reason, 'corrupt');
    const invalid = structuredClone(result.settings); invalid.resources.diamondDailyLimit = -1;
    assert.throws(() => saveAutomationSettings('a', invalid, { file, revision: result.revision }));
    assert.equal(recover(file).recovery.required, true);
    const settings = structuredClone(result.settings); settings.resources.diamondDailyLimit = 3000;
    assert.throws(() => saveAutomationSettings('a', settings, { file, revision: result.revision }), /恢复状态/);
    assert.throws(() => saveAutomationSettings('a', settings, { file, revision: result.revision, expectedRecoveryId: 'old-recovery' }), /恢复状态/);
    const saved = saveAutomationSettings('a', settings, { file, revision: result.revision, expectedRecoveryId: result.recovery.id });
    assert.equal(saved.revision, result.revision + 1); assert.equal(saved.recovery, undefined);
    assert.equal(recover(file).recovery, undefined); assert.equal(JSON.parse(fs.readFileSync(file)).accounts.a.recovery, undefined);
  });

  await test('有效旧版本正常迁移，读取不写文件、不触发恢复', () => {
    const { dir, file } = fixture(), old = record(); old.settingsVersion = 12;
    for (const row of old.settings.fleetSpeed.fleets) Object.assign(row, { repairMaxDiamonds: 0, marchMaxDiamonds: 1 });
    write(file, { version: 12, accounts: { a: old } }); const bytes = fs.readFileSync(file), result = recover(file);
    assert.equal(result.recovery, undefined); assert.equal(result.revision, 4);
    assert(result.settings.fleetSpeed.fleets.every(row => !Object.hasOwn(row, 'repairMaxDiamonds')));
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('版本13补齐跟随方式并保留全部选择，读取不触发恢复或写盘', () => {
    const { dir, file } = fixture(), old = record(12);
    old.settingsVersion = 13;
    Object.assign(old.settings.treasure, { enabled: true, follow: true, repeatAttack: true, followNames: ['测试队友'], fleetIds: ['1远征船'] });
    Object.assign(old.settings.resources, { allowDiamonds: true, diamondDailyLimit: 3210 });
    old.settings.loop.everySeconds = 87;
    const expected = structuredClone(old.settings);
    delete old.settings.treasure.followMode;
    write(file, { version: 13, accounts: { a: old } });
    const bytes = fs.readFileSync(file), result = recover(file);
    assert.deepEqual(result.settings, expected); assert.equal(result.revision, 12);
    assert.equal(result.savedAt, old.savedAt); assert.equal(result.recovery, undefined);
    assert.deepEqual(loadAutomationSettings('a', { file }), result);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('已写入版本14与无版本旧账号混存时均可读取，保存保留另一个账号', () => {
    const { dir, file } = fixture(), current = record(244);
    current.settingsVersion = 14;
    Object.assign(current.settings.treasure, { enabled: true, follow: true, repeatAttack: true, followMode: 'eachTime',
      followNames: ['测试队友'], fleetIds: ['1远征船'] });
    current.settings.resources.diamondDailyLimit = 4321;
    const legacy = { revision: 1, savedAt: '2026-11-17T00:00:00.000Z', settings: {
      treasure: { enabled: true, follow: true, followNames: ['旧账号队友'], fleetIds: ['2远征船'] }, resources: { allowDiamonds: false },
    } };
    write(file, { version: 14, accounts: { a: current, legacy } });
    const bytes = fs.readFileSync(file), result = recover(file);
    assert.deepEqual(result.settings, current.settings); assert.equal(result.revision, current.revision);
    assert.equal(result.recovery, undefined); assert.deepEqual(loadAutomationSettings('a', { file }), result);
    const old = loadRecoverableAutomationSettings('legacy', { file, expected: true });
    assert.equal(old.recovery, undefined); assert.equal(old.revision, 1);
    assert.equal(old.settings.treasure.enabled, true); assert.equal(old.settings.treasure.follow, true);
    assert.equal(old.settings.treasure.followMode, 'trigger'); assert.deepEqual(old.settings.treasure.followNames, ['旧账号队友']);
    assert.equal(old.settings.resources.allowDiamonds, false);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
    const saved = saveAutomationSettings('a', result.settings, { file, revision: result.revision });
    assert.deepEqual(saved.settings, current.settings); assert.equal(saved.revision, 245);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).accounts.legacy, legacy);
    assert.equal(recover(file).settings.treasure.followMode, 'eachTime'); assert.equal(backups(dir).length, 0);
  });

  await test('高版本容器或账号按内容兼容，保存不降级且保留元数据和其他账号', () => {
    for (const variant of ['store', 'target', 'other']) {
      const { dir, file } = fixture(), value = store({ a: record(), other: record() });
      const future = SETTINGS_SCHEMA_VERSION + 5;
      if (variant === 'store') value.version = future;
      else value.accounts[variant === 'target' ? 'a' : 'other'].settingsVersion = future;
      value.writerMetadata = { name: 'newer-program', revision: 2 };
      value.accounts.a.editorMetadata = { author: 'synthetic', flags: [1, 2] };
      value.accounts.a.settings.resources.diamondDailyLimit = 4321;
      value.accounts.other.settings.loop.everySeconds = 91;
      write(file, value); const bytes = fs.readFileSync(file);
      const loaded = recover(file);
      assert.deepEqual(loaded.settings, value.accounts.a.settings); assert.equal(loaded.recovery, undefined);
      assert.deepEqual(loadAutomationSettings('a', { file }), loaded);
      assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
      const edited = structuredClone(loaded.settings); edited.loop.everySeconds = 79;
      const saved = saveAutomationSettings('a', edited, { file, revision: loaded.revision });
      const next = JSON.parse(fs.readFileSync(file));
      assert.deepEqual(saved.settings, edited); assert.equal(saved.revision, loaded.revision + 1);
      assert(next.version >= value.version, '容器版本不得降级');
      assert.equal(next.accounts.a.settingsVersion, value.accounts.a.settingsVersion, '账号版本不得降级');
      assert.deepEqual(next.writerMetadata, value.writerMetadata);
      assert.deepEqual(next.accounts.a.editorMetadata, value.accounts.a.editorMetadata);
      assert.deepEqual(next.accounts.other, value.accounts.other);
      assert.deepEqual(recover(file).settings, edited); assert.equal(backups(dir).length, 0);
    }
  });

  await test('高版本未知字段、非法值和有损规范化按具体字段拒绝，三种入口均不覆盖', () => {
    const mutations = [
      ['factory.newerRule', settings => { settings.factory.newerRule = true; }],
      ['resources.diamondDailyLimit', settings => { settings.resources.diamondDailyLimit = -1; }],
      ['fleetSpeed.fleets.0.repairMaxDiamonds', settings => { settings.fleetSpeed.fleets[0].repairMaxDiamonds = 7; }],
      ['lineups.presets.0.name', settings => { settings.lineups.presets = [{ id: 'one', name: ' 测试阵容 ',
        formation: { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' } }]; }],
    ];
    for (const [field, mutate] of mutations) for (const target of ['a', 'other']) {
      const { dir, file } = fixture(), value = store({ a: record(), other: record() });
      value.accounts[target].settingsVersion = SETTINGS_SCHEMA_VERSION + 1;
      mutate(value.accounts[target].settings);
      write(file, value); const bytes = fs.readFileSync(file);
      const incompatible = error => {
        assert.equal(error.code, 'SETTINGS_INCOMPATIBLE');
        assert.equal(error.settingsVersion, SETTINGS_SCHEMA_VERSION + 1);
        assert.equal(error.supportedVersion, SETTINGS_SCHEMA_VERSION);
        assert(error.fields?.[field], '缺少具体字段诊断：' + field);
        assert(error.message.includes(field));
        assert(error.message.includes(String(SETTINGS_SCHEMA_VERSION + 1)));
        assert(error.message.includes(String(SETTINGS_SCHEMA_VERSION)));
        assert.match(error.message, /未覆盖原文件/);
        return true;
      };
      assert.throws(() => recover(file), incompatible);
      assert.throws(() => loadAutomationSettings('a', { file }), incompatible);
      assert.throws(() => saveAutomationSettings('a', defaultSettings(), { file, revision: value.accounts.a.revision }), incompatible);
      assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
    }
  });

  await test('高版本容器或条目结构不兼容时不能重置为默认配置', () => {
    const future = SETTINGS_SCHEMA_VERSION + 1;
    for (const mutate of [
      value => { value.version = future; value.accounts = []; },
      value => { value.version = future; value.accounts.a = null; },
      value => { value.accounts.a.settingsVersion = future; value.accounts.a.revision = '4'; },
      value => { value.accounts.a.settingsVersion = future; value.accounts.a.recovery = { required: true, reason: 'new-kind' }; },
    ]) {
      const { dir, file } = fixture(), value = store({ a: record(), other: record() }); mutate(value);
      write(file, value); const bytes = fs.readFileSync(file);
      const incompatible = error => error.code === 'SETTINGS_INCOMPATIBLE' && Object.keys(error.fields ?? {}).length > 0;
      assert.throws(() => recover(file), incompatible);
      assert.throws(() => loadAutomationSettings('a', { file }), incompatible);
      assert.throws(() => saveAutomationSettings('a', defaultSettings(), { file, revision: 4 }), incompatible);
      assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
    }
  });

  await test('I/O读取和备份失败均不覆盖原文件', () => {
    const { dir, file } = fixture(); fs.writeFileSync(file, '{broken'); const bytes = fs.readFileSync(file);
    const originalRead = fs.readFileSync, originalOpen = fs.openSync;
    try {
      fs.readFileSync = function (target, ...args) {
        if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return originalRead.call(this, target, ...args);
      };
      assert.throws(() => recover(file), /未覆盖原文件/);
    } finally { fs.readFileSync = originalRead; }
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
    try {
      fs.openSync = function (target, ...args) {
        if (String(target).includes('.corrupt-')) throw Object.assign(new Error('backup denied'), { code: 'EACCES' });
        return originalOpen.call(this, target, ...args);
      };
      assert.throws(() => recover(file), /备份挂机配置失败/);
    } finally { fs.openSync = originalOpen; }
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(backups(dir).length, 0);
  });

  await test('并发恢复在锁内复读，只写一次默认配置和备份', async () => {
    const { dir, file } = fixture(), bad = record(5); bad.settings.loop.rounds = -1;
    write(file, store({ a: bad })); const bytes = fs.readFileSync(file);
    const code = `import {loadRecoverableAutomationSettings} from ${JSON.stringify(moduleUrl)};const result=loadRecoverableAutomationSettings('a',{file:process.argv[1],expected:true});console.log(JSON.stringify({revision:result.revision,recovery:result.recovery}));`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, file], { windowsHide: true, env: process.env });
      let out = '', err = ''; child.stdout.on('data', value => { out += value; }); child.stderr.on('data', value => { err += value; });
      child.on('error', reject); child.on('exit', status => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    });
    const results = await Promise.all([run(), run(), run()]);
    assert(results.every(result => result.revision === 6));
    assert(results.every(result => result.recovery.backupFile === results[0].recovery.backupFile));
    assert.equal(backups(dir).length, 1); assert.deepEqual(fs.readFileSync(results[0].recovery.backupFile), bytes);
  });
  console.log('挂机配置恢复存储专项 ' + passed + '/' + passed + ' 通过');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
