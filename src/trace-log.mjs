import fs from 'node:fs';
import path from 'node:path';

const secretKey = /(?:password|passwd|pwd|token|secret|sign|signature|sessionkey|sessionid|authorization|cookie|openid|unionid|phone|mobile|credentials|login|loginframehex|anonymouscode|cloudcode|qrimage)$/i;

export function redactText(value) {
  return value
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[已脱敏]')
    .replace(/(["']?)\b((?:access[_-]?|refresh[_-]?)?token|password|passwd|pwd|secret|sign|signature|(?:host[_-]?)?session[_-]?(?:key|id)|anonymous[_-]?code|cloud[_-]?(?:anonymous[_-]?)?code|authorization|cookie|open[_-]?id|union[_-]?id|phone|mobile|loginFrameHex)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s&,;]+)/gi, '$1$2$1=[已脱敏]')
    .replace(/(https?:\/\/|wss?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已脱敏]@');
}

// 所有日志出口共用同一序列化规则，兼容 Error、大整数和循环引用。
export function traceJson(value) {
  const ancestors = [];
  return JSON.stringify(value, function (key, item) {
    const normalizedKey = key.replace(/[_-]/g, '');
    if (secretKey.test(normalizedKey) || (normalizedKey.toLowerCase() === 'code' && typeof item === 'string')) return '[已脱敏]';
    if (typeof item === 'string' && (['frameid', 'gestureid'].includes(normalizedKey.toLowerCase()) || /^data:image\//i.test(item))) return '[已脱敏]';
    if (typeof item === 'string') return redactText(item);
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) return { name: item.name, message: redactText(item.message), stack: redactText(item.stack ?? '') };
    if (item && typeof item === 'object') {
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(item)) return '[循环引用]';
      ancestors.push(item);
    }
    return item;
  });
}

export function redactLog(value) {
  const serialized = traceJson(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

export function emitDiagnostic(client, event, data) {
  try { client.emit?.('diagnostic', { ...data, event }); } catch { /* 日志观察者不能中断玩法。 */ }
}

// 轮流使用两个固定文件。通过已打开的句柄原地清零，避免轮转触发卷上的删除回收策略。
export function createTraceLog(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
  const files = [file, file + '.1'];
  let index = 0, fd = null, bytes = 0, initialized = false, closed = false;

  function trim(target) {
    try { if (fs.statSync(target).size > limit) fs.truncateSync(target, 0); } catch { /* 文件不存在 */ }
  }
  function open(nextIndex, truncate = false) {
    const target = files[nextIndex];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const next = fs.openSync(target, 'a');
    let size;
    try {
      // Windows 的追加句柄不能 ftruncate；truncateSync 另开可写句柄，就地清零。
      if (truncate) fs.truncateSync(target, 0);
      size = fs.fstatSync(next).size;
    } catch (error) {
      fs.closeSync(next);
      throw error;
    }
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略关闭错误 */ } }
    fd = next;
    index = nextIndex;
    bytes = size;
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    for (const target of files) trim(target);
    const modified = files.map(target => { try { return fs.statSync(target).mtimeMs; } catch { return -1; } });
    if (modified[1] > modified[0]) index = 1;
  }

  return {
    write(text) {
      if (closed) return;
      initialize();
      let data = Buffer.from(String(text));
      if (data.length > limit) {
        // 大回包保留完整 UTF-8 前缀并标明截断，单条写入也遵守文件上限。
        const marker = Buffer.from(' [日志过长，已截断]\n');
        let end = Math.max(0, limit - marker.length);
        while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
        data = marker.length <= limit ? Buffer.concat([data.subarray(0, end), marker]) : Buffer.alloc(0);
      }
      const size = data.length;
      try {
        if (fd === null) open(index);
        if (bytes > 0 && bytes + size > limit) open(1 - index, true);
      } catch { return; }
      try { bytes += fs.writeSync(fd, data); } catch {
        try { fs.closeSync(fd); } catch { /* 下一次日志写入重试打开 */ }
        fd = null;
      }
    },
    close() {
      closed = true;
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略关闭错误 */ } }
      fd = null;
      return Promise.resolve();
    },
    get files() { return [...files]; },
    get current() { return files[index]; },
  };
}
