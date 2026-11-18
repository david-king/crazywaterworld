import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDouyinSdkSandbox, extractDouyinInitOptions } from './douyin-sdk-sandbox.mjs';

export const DOUYIN_GAME_APP_ID = 'tt76340089e939a1bf02';
const CDN = 'https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/tt/';
const GATEWAY = 'wss://dhyaoj-gate.khlgamen.com/ws';
const VERSION = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2,3}$/;
const HASH = /^[a-f0-9]{5,32}$/i;
const SDK_HOSTS = new Set(['api.gzxianc.com', 'api.gzxiancheng.com', 'minigame.ewan.cn',
  'minigame-channel.cwmob.cn', 'minigame.diomasce.com', 'cdn.gzxianc.com', 'ctu-constantid.ewan.cn',
  'logs.yiworld.com', 'logs-v4.yiworld.com', 'logs-v6.yiworld.com', 'minigame-log.ewan.cn',
  'logs.miaogame.cn', 'logs-v4.miaogame.cn', 'logs-v6.miaogame.cn', 'minigame-log.miaogame.cn']);
const MESSAGES = {
  resources: '未找到抖音版游戏资源。请在电脑抖音中打开一次《疯狂水世界》，或将 CW_DOUYIN_GAME_DIR 设置为该游戏的版本目录。',
  package: '抖音游戏资源不完整或格式不兼容，请在电脑抖音更新游戏后重试。',
  version: '未能读取抖音游戏当前版本，请检查游戏 CDN 网络后重试。',
  session: '抖音登录状态已失效，请重新生成二维码登录。',
  code: '未能取得抖音小游戏登录凭证，请重新扫码并完成手机确认。',
  network: '抖音游戏登录服务暂时无法连接，请稍后重试。',
  sdk: '抖音游戏认证未完成，请更新电脑抖音中的游戏后重新扫码。',
  credential: '抖音游戏未返回完整登录凭证，请重新扫码。',
  timeout: '抖音游戏登录超时，请重新扫码。',
  cancelled: '抖音登录已取消。',
};
export class DouyinGameAuthError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'sdk';
    super(MESSAGES[safeCode]); this.name = 'DouyinGameAuthError'; this.code = safeCode;
  }
}
export function safeDouyinGameAuthError(error) {
  return new DouyinGameAuthError(error instanceof DouyinGameAuthError && Object.hasOwn(MESSAGES, error.code) ? error.code : 'sdk');
}
const fail = code => new DouyinGameAuthError(code);
function check(signal) { if (signal?.aborted) throw fail('cancelled'); }
export function validDouyinVersion(value) { return typeof value === 'string' && VERSION.test(value); }

function staticFile(root, relative, maxBytes) {
  const file = fs.realpathSync(path.join(root, relative));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > maxBytes) throw fail('package');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}
function readPackage(directory) {
  const root = fs.realpathSync(directory);
  const version = path.basename(root);
  if (!validDouyinVersion(version)) throw fail('package');
  const names = fs.readdirSync(path.join(root, 'src')).filter(name => /^settings(?:\.[a-z0-9]+)?\.json$/i.test(name));
  if (names.length !== 1) throw fail('package');
  return { directory: root, version,
    sdkSource: staticFile(root, 'subpackages/minisdk/ttMiniSuperSDK.js', 3_000_000),
    gameSource: staticFile(root, 'subpackages/main/game.js', 40_000_000),
    settings: JSON.parse(staticFile(root, path.join('src', names[0]), 3_000_000)) };
}
export function findDouyinGameResources({ env = process.env } = {}) {
  let base = env.CW_DOUYIN_GAME_DIR;
  if (!base && env.APPDATA) base = path.join(env.APPDATA, 'douyin', 'microGameCache', 'resource', 'packages', DOUYIN_GAME_APP_ID);
  if (!base) throw fail('resources');
  try {
    if (validDouyinVersion(path.basename(path.resolve(base)))) return readPackage(base);
    const versions = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && validDouyinVersion(entry.name))
      .map(entry => entry.name).sort((left, right) => {
        const a = left.split('.').map(Number), b = right.split('.').map(Number);
        for (let i = 0; i < Math.max(a.length, b.length); i++) if ((b[i] || 0) !== (a[i] || 0)) return (b[i] || 0) - (a[i] || 0);
        return 0;
      });
    for (const version of versions) { try { return readPackage(path.join(base, version)); } catch {} }
  } catch {}
  throw fail('resources');
}

function httpsUrl(raw, hosts) {
  let url;
  try { url = new URL(raw); } catch { throw fail('network'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.has(url.hostname)) throw fail('network');
  return url;
}
async function readLimited(response, limit, signal) {
  const size = Number(response.headers?.get?.('content-length'));
  if (size > limit) throw fail('network');
  if (!response.body?.getReader) {
    const text = await response.text(); check(signal);
    if (Buffer.byteLength(text) > limit) throw fail('network');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      check(signal);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw fail('network');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
async function requestText(url, { fetchImpl, signal, timeoutMs = 30_000, headers = {}, method = 'GET', body, maxBytes = 12_000_000 }) {
  check(signal);
  const controller = new AbortController();
  let timeout = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, Math.min(Math.max(timeoutMs, 1), 120_000));
  timer.unref?.();
  let onAbort;
  const interrupted = new Promise((resolve, reject) => {
    onAbort = () => reject(fail(timeout ? 'timeout' : 'cancelled'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url.href, { method, headers, body, signal: controller.signal, redirect: 'manual' });
      if (controller.signal.aborted) throw fail(timeout ? 'timeout' : 'cancelled');
      if (response.status >= 300 && response.status < 400) throw fail('network');
      const text = await readLimited(response, maxBytes, controller.signal);
      check(signal);
      const header = Object.fromEntries(response.headers?.entries?.() || []);
      return { statusCode: response.status, data: text, header };
    })(), interrupted]);
  } catch (error) {
    if (error instanceof DouyinGameAuthError) throw error;
    throw fail(signal?.aborted ? 'cancelled' : timeout ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
async function publicJson(raw, options) {
  const url = httpsUrl(raw, new Set(['dhyaoj-cdn.khlgamen.com']));
  if (!url.href.startsWith(CDN)) throw fail('version');
  const result = await requestText(url, options);
  if (result.statusCode !== 200) throw fail('version');
  try { return JSON.parse(result.data); } catch { throw fail('version'); }
}
function decodeUuid(value) {
  if (typeof value !== 'string') throw fail('version');
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  if (!/^[0-9a-f]{2}[A-Za-z0-9+/]{20}$/i.test(value)) throw fail('version');
  const full = value.slice(0, 2) + Buffer.from(value.slice(2), 'base64').toString('hex');
  return full.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toLowerCase();
}
function appConfigFromAsset(asset) {
  const matches = [], queue = [asset];
  let visited = 0;
  while (visited < queue.length && visited < 100_000) {
    const value = queue[visited++];
    if (!value || typeof value !== 'object') continue;
    if (value.config?.version && value.bundle?.server) matches.push(value);
    queue.push(...Object.values(value));
  }
  if (matches.length !== 1 || !validDouyinVersion(matches[0].config.version) || matches[0].bundle.server !== CDN) throw fail('version');
  return matches[0];
}
export async function resolveDouyinClientVersion(resources, { fetchImpl = fetch, signal, timeoutMs = 30_000 } = {}) {
  try {
    check(signal);
    if (!validDouyinVersion(resources?.version) || resources.settings?.assets?.server !== CDN) throw fail('version');
    const hash = resources.settings.assets.bundleVers?.resources;
    if (typeof hash !== 'string' || !HASH.test(hash)) throw fail('version');
    const options = { fetchImpl, signal, timeoutMs };
    const config = await publicJson(`${CDN}remote/resources/config.${hash}.json`, options);
    const entry = Object.entries(config.paths || {}).filter(([, value]) => value?.[0] === 'appConfig');
    if (entry.length !== 1 || !/^\d+$/.test(entry[0][0])) throw fail('version');
    const index = Number(entry[0][0]), uuid = decodeUuid(config.uuids?.[index]);
    const versions = config.versions?.import;
    if (!Array.isArray(versions)) throw fail('version');
    let assetHash;
    for (let i = 0; i < versions.length; i += 2) if (Number(versions[i]) === index) assetHash = versions[i + 1];
    if (typeof assetHash !== 'string' || !HASH.test(assetHash)) throw fail('version');
    const asset = await publicJson(`${CDN}remote/resources/import/${uuid.slice(0, 2)}/${uuid}.${assetHash}.json`, options);
    const appConfig = appConfigFromAsset(asset);
    const manifest = await publicJson(`${CDN}${appConfig.config.version}/version.manifest`, options);
    if (!validDouyinVersion(manifest.version) || (manifest.loginServer && manifest.loginServer !== GATEWAY)
      || manifest.isServerMaintenance === true) throw fail('version');
    return { clientVersion: manifest.version, gateway: GATEWAY };
  } catch (error) {
    if (signal?.aborted || error?.code === 'cancelled') throw fail('cancelled');
    throw fail('version');
  }
}

export async function requestDouyinMiniGameCode({ sessionId, fetchImpl = fetch, signal, timeoutMs = 30_000 }) {
  check(signal);
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096 || /[\s\x00-\x1f\x7f]/.test(sessionId)) throw fail('session');
  const url = new URL('https://minigame.zijieapi.com/mgplatform/api/apps/v3/login');
  url.search = new URLSearchParams({ appid: DOUYIN_GAME_APP_ID, aid: '6383', anonymousid: '' }).toString();
  const result = await requestText(url, { fetchImpl, signal, timeoutMs, maxBytes: 2_000_000,
    headers: { 'X-Tma-Host-Sessionid': sessionId, 'X-Tma-Host-Deviceid': '' } });
  let response;
  try { response = JSON.parse(result.data); } catch { throw fail('code'); }
  const data = response.data;
  if (result.statusCode !== 200 || response.err_no !== 0 || data?.isLogin !== true
    || typeof data.code !== 'string' || !data.code || data.code.length > 65_536) throw fail('code');
  return { code: data.code, anonymousCode: typeof data.anonymousCode === 'string' ? data.anonymousCode : '', isLogin: true };
}

export function createDouyinSdkTransport({ fetchImpl = fetch, signal } = {}) {
  return async request => {
    check(signal); check(request.signal);
    const url = httpsUrl(request.url, SDK_HOSTS);
    const method = String(request.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw fail('network');
    const headers = {};
    for (const [name, value] of Object.entries(request.header || {})) {
      // Never relay website cookies or unrelated credentials to publisher services.
      if (/^(?:cookie|authorization|proxy-authorization|host|x-tma-host-sessionid)$/i.test(name)) continue;
      if (typeof value === 'string' || typeof value === 'number') headers[name] = String(value);
    }
    let body;
    if (method === 'GET' && request.data && typeof request.data === 'object') {
      for (const [key, value] of Object.entries(request.data)) if (value != null) url.searchParams.set(key, String(value));
    } else if (method === 'POST' && request.data != null) {
      body = typeof request.data === 'string' || request.data instanceof Uint8Array ? request.data : JSON.stringify(request.data);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await requestText(url, { fetchImpl, signal: controller.signal, method, headers, body, timeoutMs: request.timeout || 30_000 });
      if (request.dataType !== 'text') { try { result.data = JSON.parse(result.data); } catch {} }
      return result;
    } finally { signal?.removeEventListener('abort', abort); request.signal?.removeEventListener('abort', abort); }
  };
}

function pcSystemInfo() {
  return { platform: 'windows', system: `Windows ${os.release()}`, model: 'PC', brand: '', version: '', SDKVersion: '',
    language: 'zh_CN', networkType: 'wifi', pixelRatio: 1, screenWidth: 1280, screenHeight: 720,
    windowWidth: 1280, windowHeight: 720, appName: 'Douyin' };
}
function stringField(value) { return typeof value === 'string' && value.length > 0 && value.length <= 65_536; }
export async function exchangeDouyinCredential({
  sessionId, signal, env = process.env, fetchImpl = fetch, now = Date.now, timeoutMs = 120_000,
  createSandbox = createDouyinSdkSandbox, systemInfo = pcSystemInfo(), userAgent = '',
} = {}) {
  check(signal);
  const controller = new AbortController();
  let expired = false, sandbox;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  let aborted;
  const interruption = new Promise((resolve, reject) => {
    aborted = () => reject(fail(expired ? 'timeout' : 'cancelled'));
    controller.signal.addEventListener('abort', aborted, { once: true });
  });
  try {
    return await Promise.race([(async () => {
      const resources = findDouyinGameResources({ env });
      const initOptions = extractDouyinInitOptions(resources.gameSource);
      const version = await resolveDouyinClientVersion(resources, { fetchImpl, signal: controller.signal });
      check(controller.signal);
      sandbox = createSandbox({ sdkSource: resources.sdkSource, systemInfo, userAgent,
        signal: controller.signal, transport: createDouyinSdkTransport({ fetchImpl, signal: controller.signal }),
        acquireLoginCode: () => requestDouyinMiniGameCode({ sessionId, fetchImpl, signal: controller.signal }) });
      await sandbox.init(initOptions, timeoutMs);
      check(controller.signal);
      const login = await sandbox.login(timeoutMs);
      check(controller.signal);
      const info = await sandbox.getDataInfo(30_000);
      check(controller.signal);
      if (!['openId', 'token', 'sign'].every(key => stringField(login?.[key]))
        || typeof login?.timestamp !== 'string' || !/^\d{1,19}$/.test(login.timestamp) || BigInt(login.timestamp) <= 0n
        || BigInt(login.timestamp) > 9223372036854775807n || !stringField(info?.appId) || !stringField(info?.channelId)) throw fail('credential');
      return { url: version.gateway, source: 'douyin', capturedAt: new Date(now()).toISOString(), login: {
        language: 'zh_CN', worldId: 0, systemLanguage: 'zh-CN',
        eworldParams: { openId: login.openId, token: login.token, timestamp: login.timestamp, sign: login.sign },
        eworldClientInfo: { appId: info.appId, channelId: info.channelId, did: typeof info.did === 'string' ? info.did : '',
          deviceModule: '', clientVersion: version.clientVersion, networkType: 'Wifi', platform: '5', sc: '', extc: '', biz: '',
          isAuth: login.isAuth === true, birthday: typeof login.birthday === 'string' ? login.birthday : '', originVersion: '' },
      } };
    })(), interruption]);
  } catch (error) {
    if (expired) throw fail('timeout');
    if (signal?.aborted) throw fail('cancelled');
    if (error instanceof DouyinGameAuthError) throw error;
    throw fail('sdk');
  } finally {
    controller.abort();
    try { sandbox?.close(); } catch {}
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', aborted);
    sessionId = undefined;
  }
}
