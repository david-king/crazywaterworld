export const residentMaterialReasons = {
  blockedMaterials: '包含不准消耗的材料',
  skipCrops: '订单含农作物或使用农作物的加工品',
  skipProduction: '可用库存不足，已设置跳过需生产的订单',
};

export function hasResidentMaterialRules(resident) {
  return !!(resident?.skipCrops || resident?.skipProduction || resident?.blockedMaterials?.length);
}

export function cropRelatedMaterialIds(config, cropIds = config?.tables?.FarmlandPlantCfg?.data?.map(row => row.id)) {
  const related = new Set(cropIds);
  const recipes = config?.tables?.BuildingProduceCfg?.data ?? [];
  let previousSize;
  do {
    previousSize = related.size;
    for (const recipe of recipes) {
      if (recipe.costItem?.some(([id, num]) => num > 0 && related.has(id))) related.add(recipe.itemId);
    }
  } while (related.size !== previousSize);
  return related;
}

// available 只计算可支配的现货。整单命中任一项，其他材料也无需预留或排产。
export function residentMaterialRule(resident, requirements, cropRelatedIds, available) {
  if (!resident?.enabled) return null;
  if (requirements.some(item => resident.blockedMaterials?.includes(item.id))) return 'blockedMaterials';
  if (resident.skipCrops && requirements.some(item => cropRelatedIds.has(item.id))) return 'skipCrops';
  if (resident.skipProduction && available && requirements.some(item => available(item.id) < item.num)) return 'skipProduction';
  return null;
}
