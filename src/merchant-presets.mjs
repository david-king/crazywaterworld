import { DEFAULT_SETTINGS } from './automation-settings.mjs';
import { merchantPresetSettings } from './merchant-preset-settings.mjs';

const policies = merchantPresetSettings(DEFAULT_SETTINGS.merchant);
const schedule = { merchantTrade: true, merchantRewards: true, tradeTasks: true };

export const merchantPresets = [
  { id: 'free', label: '免费跑船', description: '零针自然航行，优先可接下一程的盈利港。解锁后用钻石升船。',
    settings: { merchant: policies.free, schedule } },
  { id: 'eventFree', label: '仅用本期免费针', description: '保留原有库存，用本期新领的免费针加速，解锁后用钻石升船。',
    settings: { merchant: policies.eventFree, schedule } },
  { id: 'sprint', label: '冲刺 5,000 万（达标优先）', description: '每天等已知紧缺港达到 12 个或 15:00 后再用针，加速载货回款升船，最后一个交易日优先加速成交。累计利润达到 5,000 万后停针，继续自然走商。',
    settings: { merchant: policies.sprint, schedule } },
];

export function merchantPresetOptions(settings) {
  return merchantPresets.map(({ id, label, description, settings: preset }) => ({
    id, label, description, totalPointers: preset.merchant.speedUpMode === 'eventFree' ? null : preset.merchant.periodPointerLimit,
    active: Object.entries(preset).every(([group, values]) =>
      Object.entries(values).every(([key, value]) => settings[group][key] === value)),
  }));
}
