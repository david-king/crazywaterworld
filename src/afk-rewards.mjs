// 服务器用秒记录本段挂机的起止时间，账号的收益上限可能不同。
export function afkClaimTime(info, intervalHours = 0) {
  const finish = info?.afkFinishTime;
  if (!Number.isSafeInteger(finish) || finish <= 0) return null;
  const start = info.afkStartTime;
  if (!Number.isSafeInteger(start) || start <= 0 || !(intervalHours > 0)) return finish;
  return Math.min(start + intervalHours * 3600, finish);
}
