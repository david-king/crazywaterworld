import vm from 'node:vm';

// The publisher SDK stays in the user's local game installation. This adapter
// supplies only in-memory storage and explicit I/O; it never reads browser stores.
export function extractDouyinInitOptions(gameSource) {
  const start = gameSource.indexOf('System.register("chunks:///_virtual/TTEWanSDK.ts"');
  const end = start < 0 ? -1 : gameSource.indexOf('new ttEwSDK', start);
  if (start < 0 || end < start || end - start > 50_000) throw new Error('抖音游戏 SDK 配置无法识别，请在电脑抖音更新游戏后重试。');
  const block = gameSource.slice(start, end);
  const appId = block.match(/\.APP_ID="([^"]+)"/)?.[1];
  const appSecretKey = block.match(/\.APP_SECRET_KEY="([^"]+)"/)?.[1];
  if (!appId || !appSecretKey) throw new Error('抖音游戏 SDK 配置不完整，请更新游戏后重试。');
  return { appId, appSecretKey, isLandscape: false };
}

export function createDouyinSdkSandbox({
  sdkSource, systemInfo, launchOptions = { scene: '', query: {} },
  transport, acquireLoginCode, signal, userAgent = '',
}) {
  if (!sdkSource || !systemInfo?.platform || typeof transport !== 'function' || typeof acquireLoginCode !== 'function') {
    throw new Error('抖音游戏 SDK 运行环境不完整。');
  }
  const timers = new Set(), intervals = new Set(), requests = new Set(), operations = new Set();
  const storage = new Map(), noop = () => {}, clone = value => structuredClone(value);
  let closed = false, factory, context, sdk;
  const stopped = () => Object.assign(new Error('抖音登录已取消。'), { name: 'AbortError' });
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
    for (const controller of requests) controller.abort();
    for (const finish of [...operations]) finish(false, stopped());
    timers.clear(); intervals.clear(); requests.clear(); operations.clear(); storage.clear();
    sdk = null;
    context = null;
  }
  function later(fn, delay, ...args) {
    if (closed) return 0;
    const timer = setTimeout(() => { timers.delete(timer); if (!closed) { try { fn(...args); } catch {} } }, Math.max(0, Number(delay) || 0));
    timers.add(timer); timer.unref?.(); return timer;
  }
  function interval(fn, delay, ...args) {
    if (closed) return 0;
    const timer = setInterval(() => { if (!closed) { try { fn(...args); } catch {} } }, Math.max(1, Number(delay) || 1));
    intervals.add(timer); timer.unref?.(); return timer;
  }
  const clearTimer = timer => { clearTimeout(timer); timers.delete(timer); };
  const clearLoop = timer => { clearInterval(timer); intervals.delete(timer); };
  const api = {
    getSystemInfoSync: () => clone(systemInfo),
    getSystemInfo: options => { options.success?.(clone(systemInfo)); options.complete?.({}); },
    getLaunchOptionsSync: () => clone(launchOptions), getEnterOptionsSync: () => clone(launchOptions),
    getNetworkType: options => options.success?.({ networkType: systemInfo.networkType || 'wifi' }),
    getStorageSync: key => storage.has(key) ? clone(storage.get(key)) : '',
    setStorageSync: (key, value) => { if (!closed) storage.set(key, clone(value)); },
    removeStorageSync: key => storage.delete(key),
    getStorage: options => { options.success?.({ data: api.getStorageSync(options.key) }); options.complete?.({}); },
    setStorage: options => { api.setStorageSync(options.key, options.data); options.success?.({}); options.complete?.({}); },
    removeStorage: options => { storage.delete(options.key); options.success?.({}); options.complete?.({}); },
    getSetting: options => options.success?.({ authSetting: {} }),
    login: options => {
      if (closed) return;
      Promise.resolve().then(() => { if (closed) throw stopped(); return acquireLoginCode({ force: options.force, signal }); }).then(result => {
        if (closed) return;
        if (!result?.code) throw new Error('missing code');
        options.success?.(result); options.complete?.(result);
      }).catch(() => { if (!closed) options.fail?.({ errMsg: 'login:fail 无法取得抖音小游戏登录凭证' }); });
    },
    canIUse: () => false,
    getGameRecorderManager: () => ({ onError: noop, onStart: noop, onStop: noop }),
    onShow: noop, onHide: noop, onError: noop, onMemoryWarning: noop,
    onNetworkStatusChange: noop, offNetworkStatusChange: noop,
    request: options => {
      if (closed) return { abort: noop };
      const controller = new AbortController();
      requests.add(controller);
      Promise.resolve().then(() => {
        if (closed || controller.signal.aborted) throw stopped();
        return transport({ url: options.url, method: options.method || 'GET', data: options.data,
          header: options.header || {}, timeout: options.timeout, dataType: options.dataType,
          responseType: options.responseType, signal: controller.signal });
      }).then(result => {
        if (!closed && !controller.signal.aborted) { options.success?.(result); options.complete?.(result); }
      }).catch(() => {
        if (!closed && !controller.signal.aborted) {
          const result = { errMsg: 'request:fail 抖音游戏登录服务请求失败' };
          options.fail?.(result); options.complete?.(result);
        }
      }).finally(() => requests.delete(controller));
      return { abort: () => { controller.abort(); requests.delete(controller); } };
    },
  };
  const tt = new Proxy(api, { get(target, key) {
    if (key in target) return target[key];
    return options => options?.fail?.({ errMsg: '当前登录环境不支持此接口' });
  } });
  context = { tt, Promise, console: { log: noop, warn: noop, error: noop, info: noop, debug: noop, catchError: noop },
    setTimeout: later, clearTimeout: clearTimer, setInterval: interval, clearInterval: clearLoop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    __tt_define__: (name, fn) => { if (name === 'subpackages/minisdk/ttMiniSuperSDK.js') factory = fn; },
    navigator: { userAgent }, location: { href: 'https://www.douyin.com/', hostname: 'www.douyin.com' },
    TextEncoder, TextDecoder, atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64') };
  context.window = context; context.self = context; context.globalThis = context;
  if (signal?.aborted) { close(); throw stopped(); }
  signal?.addEventListener('abort', close, { once: true });
  try {
    vm.createContext(context);
    vm.runInContext(sdkSource, context, { timeout: 5_000, filename: 'douyin-publisher-sdk.js' });
    if (typeof factory !== 'function') throw new Error('factory missing');
    context.__factory = factory;
    vm.runInContext('__exports={}; __module={exports:__exports}; __factory(()=>{throw Error("External require unavailable")},__module,__exports,undefined,Promise,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,cancelAnimationFrame,globalThis); __sdk=EworldSDKManager;', context, { timeout: 5_000 });
    sdk = context.__sdk;
    if (!sdk || !['init', 'login', 'getDataInfo'].every(key => typeof sdk[key] === 'function')) throw new Error('SDK missing');
  } catch {
    close();
    throw new Error('抖音游戏 SDK 无法加载，请在电脑抖音更新游戏后重试。');
  }
  function invoke(method, params = {}, timeoutMs = 60_000) {
    if (closed) return Promise.reject(stopped());
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(false, new Error('抖音游戏登录响应超时，请重新扫码。')), timeoutMs);
      timers.add(timer);
      const finish = (ok, result) => {
        if (settled) return;
        settled = true; clearTimer(timer); operations.delete(finish);
        ok ? resolve(result) : reject(result instanceof Error ? result : new Error('抖音游戏认证未完成，请重新扫码。'));
      };
      operations.add(finish);
      try {
        // Invoke inside the VM too, so a corrupt cached SDK cannot block synchronously forever.
        context.__call = { method, params: { ...params, onSuccess: result => finish(true, result),
          onFailed: () => finish(false, new Error('抖音游戏认证未完成，请重新扫码。')) } };
        vm.runInContext('__sdk[__call.method](__call.params);', context, { timeout: 5_000 });
      } catch { finish(false, new Error('抖音游戏 SDK 执行失败，请更新游戏后重试。')); }
      finally { if (context) delete context.__call; }
    });
  }
  return { init: (options, timeout) => invoke('init', options, timeout), login: timeout => invoke('login', {}, timeout),
    getDataInfo: timeout => invoke('getDataInfo', {}, timeout), close };
}
