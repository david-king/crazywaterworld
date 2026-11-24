import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { autoProduceConfig, autoProduceView } from '../src/factory-auto.mjs';
import { autoFactoryProducts } from '../src/world.mjs';

const config = loadConfig();
const price = autoProduceConfig(config);
assert.equal(price.costRuby, 500, '自动生产应消耗 500 钻石');
assert.equal(price.durationSeconds, 28800, '自动生产应持续 8 小时');

const survey = {
  serverNow: 1000,
  autoProduceForever: false,
  autoProduceEndTime: 4600,
  stockKnown: true,
  have: id => id === 'RUBY' ? 1200 : 0,
};
const timed = autoProduceView(config, survey);
assert.equal(timed.active, true);
assert.equal(timed.remainingSeconds, 3600);
assert.equal(timed.ruby, 1200);
assert.equal(timed.costRuby, 500);

const expired = autoProduceView(config, { ...survey, autoProduceEndTime: 900 });
assert.equal(expired.active, false);
assert.equal(expired.remainingSeconds, 0);

const forever = autoProduceView(config, { ...survey, autoProduceForever: true, autoProduceEndTime: 0 });
assert.equal(forever.active, true);
assert.equal(forever.remainingSeconds, null);

const unknownRuby = autoProduceView(config, { ...survey, stockKnown: false });
assert.equal(unknownRuby.ruby, null);

const fallback = autoProduceConfig(null);
assert.equal(fallback.costRuby, 500);
assert.equal(fallback.durationSeconds, 28800);

const autoSurvey = {
  serverNow: 1000,
  stockKnown: true,
  stockCap: 999,
  have: () => 0,
  festivals: [],
  player: { worldId: 'selftest-world', playerId: 'selftest-player' },
  factorySlots: 6,
};
const produceTypes = [...new Set((config?.tables?.BuildingProduceCfg?.data ?? [])
  .filter(row => row.buildType !== '活动工厂')
  .map(row => row.buildType))];
for (const type of produceTypes) {
  const building = { buildingId: type, type, level: 1, factory: { factoryQ: [], finishedProducts: [] } };
  const products = autoFactoryProducts(building, autoSurvey, config);
  assert.ok(products.length > 0, type + ' 应至少有一个自动生产物料');
}
const furniture = autoFactoryProducts(
  { buildingId: 'furniture', type: '家具厂', level: 1, factory: {} },
  autoSurvey, config,
);
assert.ok(furniture.length >= 1, '家具作坊即使队列数据缺失也要返回自动生产物料');

console.log('工厂自动生产配置与状态测试通过：500 钻石 / 8 小时，到期、永久和钻石余额未知状态正确');
