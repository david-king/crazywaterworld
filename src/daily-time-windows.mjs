// 每日时段使用服务器时间换算到北京时间。开始分钟包含在内，结束分钟除外。
export const dailyWindowPattern = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const secondOfDay = time => (time + 8 * 3600) % 86400;

function bounds(window) {
  const match = dailyWindowPattern.exec(window);
  if (!match) return null;
  return { start: Number(match[1]) * 3600 + Number(match[2]) * 60,
    end: Number(match[3]) * 3600 + Number(match[4]) * 60 };
}

export function inDailyWindows(windows, time) {
  if (!windows?.length) return true;
  const second = secondOfDay(time);
  return windows.some(window => {
    const range = bounds(window);
    if (!range) return false;
    const { start, end } = range;
    return start === end || (start < end ? second >= start && second < end : second >= start || second < end);
  });
}

// 让短于常规检查间隔的时段也能在开始时唤醒调度。
export function nextDailyWindowStart(windows, time) {
  if (!windows?.length) return null;
  const second = secondOfDay(time);
  let next = Infinity;
  for (const window of windows) {
    const range = bounds(window);
    if (!range) continue;
    if (range.start === range.end) return null;
    const today = time - second + range.start;
    next = Math.min(next, today > time ? today : today + 86400);
  }
  return Number.isFinite(next) ? next : null;
}
