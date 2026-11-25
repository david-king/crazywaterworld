// 旧预设同时用于识别原样保存的配置，以及配对模拟的对照组。
export function merchantPresetSettings(defaults, version = 'current') {
  const legacy = version === true || version === 'legacy';
  const current = !legacy && version !== 'v70';
  const common = { ...defaults, enabled: true, fullCargoRoutes: false, autoUpgrade: true, autoShareIntel: true,
    estimateDiscountPercent: 10, autoBuyPointers: false, pointerDailyDiamondLimit: 0, profitLimit: 0,
    knownPortChains: !legacy, minPurchaseReturnPercent: legacy ? 0 : 5, firstDepartureWaitMinutes: legacy ? 29 : 0 };
  return {
    free: { ...common, autoSpeedUp: false, dailyPointerLimit: 0, periodPointerLimit: 0 },
    eventFree: { ...common, autoSpeedUp: true, speedUpMode: 'eventFree', speedUpMaxPerLeg: 4,
      estimateDiscountPercent: current ? 7 : 10, dailyPointerLimit: current ? 100 : legacy ? 45 : 10 },
    sprint: { ...common, autoSpeedUp: true, speedUpMode: legacy ? 'goal' : 'targetFirst', speedUpMaxPerLeg: 4,
      dailyPointerLimit: legacy ? 45 : 100, periodPointerLimit: legacy ? 139 : current ? 220 : -1,
      speedUpIntelPorts: current ? 12 : 0 },
  };
}

export function migrateMerchantPreset(settings, defaults) {
  const saved = settings?.merchant;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return settings;
  const missingChain = !Object.hasOwn(saved, 'knownPortChains');
  const missingReturn = !Object.hasOwn(saved, 'minPurchaseReturnPercent');
  if (!missingChain && !missingReturn) return settings;
  let merchant = { knownPortChains: defaults.knownPortChains, minPurchaseReturnPercent: defaults.minPurchaseReturnPercent, ...saved };
  if (missingChain && missingReturn && ['merchantTrade','merchantRewards','tradeTasks'].every(key => settings.schedule?.[key] === true)) {
    const old = merchantPresetSettings(defaults, 'legacy');
    const match = Object.keys(old).find(id => Object.entries(old[id]).every(([k,v]) =>
      k === 'knownPortChains' || k === 'minPurchaseReturnPercent' || (Object.hasOwn(saved, k) ? saved[k] : defaults[k]) === v));
    if (match) {
      merchant = { ...merchant, ...merchantPresetSettings(defaults, 'v70')[match] };
      // 旧版文件继续使用已保存的针数预算。主动套用新版冲刺时才启用达标优先。
      if (match === 'sprint') Object.assign(merchant, { speedUpMode: saved.speedUpMode,
        dailyPointerLimit: saved.dailyPointerLimit, periodPointerLimit: saved.periodPointerLimit });
    }
  }
  return { ...settings, merchant };
}
