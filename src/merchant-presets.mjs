import { DEFAULT_SETTINGS } from './automation-settings.mjs';

const merchant = { ...DEFAULT_SETTINGS.merchant, enabled: true, autoUpgrade: true, autoShareIntel: true,
  estimateDiscountPercent: 10, autoBuyPointers: false, pointerDailyDiamondLimit: 0, profitLimit: 0 };
const schedule = { merchantTrade: true, merchantRewards: true, tradeTasks: true };
const sprintTotal = 139;

export const merchantPresets = [
  { id: 'free', label: '免费跑船', description: '全程自然航行，解锁后用钻石升船。', forecast: '四天模拟利润中位数约 270 万。',
    settings: { merchant: { ...merchant, autoSpeedUp: false, dailyPointerLimit: 0, periodPointerLimit: 0 }, schedule } },
  { id: 'eventFree', label: '仅用本期免费针', description: '保留原有库存，用本期新领的免费针加速，解锁后用钻石升船。',
    forecast: '免费战令、联盟任务和每日商情礼包到账后计入额度。',
    settings: { merchant: { ...merchant, autoSpeedUp: true, speedUpMode: 'eventFree', dailyPointerLimit: 45 }, schedule } },
  { id: 'sprint', label: '省针冲刺 5,000 万', description: '最后两天按利润缺口追赶，达标后停针，继续自然走商。',
    forecast: '基准行情模拟 100 次，其中 94 次达到 5,000 万。',
    settings: { merchant: { ...merchant, autoSpeedUp: true, speedUpMode: 'goal', speedUpMaxPerLeg: 4,
      dailyPointerLimit: 45, periodPointerLimit: sprintTotal }, schedule } },
];

export function merchantPresetOptions(settings) {
  return merchantPresets.map(({ id, label, description, forecast, settings: preset }) => ({
    id, label, description, forecast, totalPointers: preset.merchant.speedUpMode === 'eventFree' ? null : preset.merchant.periodPointerLimit,
    active: Object.entries(preset).every(([group, values]) =>
      Object.entries(values).every(([key, value]) => settings[group][key] === value)),
  }));
}
