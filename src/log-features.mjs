import { automationTasks } from './automation.mjs';
import { automationControls } from './automation-controls.mjs';
import { classifyLog } from './log-categories.mjs';
import { runtimeObservationKeys, worldObservationKeys } from './runtime-progress.mjs';

// Use the same task identity and Chinese names as the automation settings.
// Old entries and system messages without a known task keep their existing category.
const features = new Map();
const categoryByModule = {
  building: 'building', factory: 'production', farm: 'production', resident: 'events', cargo: 'events', events: 'events',
  gather: 'gather', pet: 'base', museum: 'base', gold: 'base', antique: 'base', forge: 'forge',
  heroes: 'heroes', appointments: 'heroes', cityWar: 'alliance', guildFort: 'alliance', alliance: 'alliance',
  silicon: 'silicon', resourceFields: 'resourceFields', worldBoss: 'boss', radar: 'radar', treasure: 'treasure',
  pirateHunt: 'pirate', pirate: 'pirate', trials: 'trials', heroRaid: 'activity', weeklyActivity: 'activity',
};
for (const { key, label, group } of automationTasks) {
  const category = classifyLog(label);
  const fallback = { '日常': 'daily', '领奖': 'daily', '折扣商店': 'daily', '周期活动': 'activity', '限时活动': 'activity', '船只': 'gather',
    '英雄': 'heroes', '联盟': 'alliance', '海面': 'building' }[group];
  features.set(key, { key, label, category: category !== 'system' ? category : fallback });
}
for (const control of automationControls) {
  const key = runtimeObservationKeys[control.key] || control.taskKey || control.key;
  const feature = features.get(key) ?? { key: control.key, label: control.label,
    category: categoryByModule[control.key.split('.')[0]] || classifyLog(control.label) };
  features.set(control.key, feature);
  features.set(key, feature);
}

export function resolveLogFeature(taskKey, module) {
  for (const source of [taskKey, module]) {
    if (typeof source !== 'string') continue;
    const key = source.split(':')[0];
    const feature = features.get(worldObservationKeys[key] ?? key);
    if (feature) return feature;
  }
}
