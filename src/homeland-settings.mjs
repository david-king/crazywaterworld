export const HOMELAND_DEFAULTS = {
  enabled: false, freeStamina: false, freeBox: false, submitOrders: false,
  mergeOrders: false, warehouseBuffer: false,
  takeWarehouse: false, unlockFloors: false, clean: false, tech: false, upgrade: false,
  keepCoins: 0, dailyCoinLimit: 500, targetLevel: 30, targetTech: 180, checkEverySeconds: 300,
};
export const HOMELAND_ACTIONS = {
  freeStamina: '领取每日免费体力', freeBox: '领取工坊免费宝箱', submitOrders: '提交工坊订单',
  mergeOrders: '合成订单所需物品',
  warehouseBuffer: '存入仓库腾出合成空位',
  takeWarehouse: '取出订单所需仓库物品', unlockFloors: '解锁家园楼层', clean: '打扫家园',
  tech: '升级家园科技', upgrade: '升级家园',
};
export const homelandEnabled = settings => settings?.loop?.world === true && settings?.homeland?.enabled === true;
