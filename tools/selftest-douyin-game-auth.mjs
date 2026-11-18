import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findDouyinGameResources, validDouyinVersion, resolveDouyinClientVersion, requestDouyinMiniGameCode,
  createDouyinSdkTransport, exchangeDouyinCredential, safeDouyinGameAuthError, DouyinGameAuthError,
} from '../src/douyin-game-auth.mjs';
import { createDouyinSdkSandbox, extractDouyinInitOptions } from '../src/douyin-sdk-sandbox.mjs';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-douyin-auth-'));
const CDN = 'https://dhyaoj-cdn.khlgamen.com/HotUpdateRes/tt/';
const SECRET = 'fixture-secret-must-never-appear-in-errors';
const GATEWAY = 'wss://dhyaoj-gate.khlgamen.com/ws';
const uuid = 'd2f7743d-f0aa-4d41-b5b1-f888fe23d3fd';
const settings = { assets: { server: CDN, bundleVers: { resources: 'abc12' } } };
const gameSource = 'System.register("chunks:///_virtual/TTEWanSDK.ts",function(){this.APP_ID="fixture-app";this.APP_SECRET_KEY="fixture-static-config";new ttEwSDK;});';
const tests = [];
const test = (name, run) => tests.push({ name, run });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function writePackage(version) {
  const root = path.join(directory, version);
  for (const folder of ['subpackages/minisdk', 'subpackages/main', 'src']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, 'subpackages/minisdk/ttMiniSuperSDK.js'), '// fixture, no original publisher SDK');
  fs.writeFileSync(path.join(root, 'subpackages/main/game.js'), gameSource);
  fs.writeFileSync(path.join(root, 'src/settings.abc12.json'), JSON.stringify(settings));
  return root;
}
const root = writePackage('1.14.6');
const env = { CW_DOUYIN_GAME_DIR: root };
function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw); calls.push({ url, options });
    let body;
    if (url.pathname.endsWith('/config.abc12.json')) body = overrides.config ?? {
      paths: { 7: ['appConfig', 1, 1] }, uuids: { 7: uuid }, versions: { import: [7, 'def34'] },
    };
    else if (url.pathname.endsWith(`${uuid}.def34.json`)) body = overrides.asset ?? [1, [[{ config: { version: '1.14.6' }, bundle: { server: CDN } }]]];
    else if (url.pathname.endsWith('/version.manifest')) body = overrides.manifest ?? { version: '1.14.6.101', loginServer: GATEWAY };
    else if (url.hostname === 'minigame.zijieapi.com') body = overrides.code ?? { err_no: 0, data: { isLogin: true, code: SECRET, session: SECRET } };
    else throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
test('resource discovery only selects complete numeric version directories', () => {
  writePackage('1.9.9'); writePackage('1.14.10');
  fs.mkdirSync(path.join(directory, '99.0.0'));
  fs.mkdirSync(path.join(directory, 'latest-secret'));
  assert.equal(findDouyinGameResources({ env: { CW_DOUYIN_GAME_DIR: directory } }).version, '1.14.10');
  assert.equal(findDouyinGameResources({ env }).version, '1.14.6');
  assert.throws(() => findDouyinGameResources({ env: {} }), error => error.code === 'resources' && /CW_DOUYIN_GAME_DIR/.test(error.message));
  assert.throws(() => findDouyinGameResources({ env: { CW_DOUYIN_GAME_DIR: path.join(directory, SECRET) } }), error => !error.message.includes(SECRET));
  for (const value of ['../1.2.3', '1.2.3/extra', '1.2', '01.2.3', '1.2.3.4.5', 'NaN', SECRET]) assert.equal(validDouyinVersion(value), false);
  assert.equal(validDouyinVersion('1.14.6.101'), true);
  assert.deepEqual(extractDouyinInitOptions(gameSource), { appId: 'fixture-app', appSecretKey: 'fixture-static-config', isLandscape: false });
});
test('current version follows validated public resource pointers, never the package number alone', async () => {
  const fixture = fixtureFetch();
  const result = await resolveDouyinClientVersion(findDouyinGameResources({ env }), fixture);
  assert.equal(result.clientVersion, '1.14.6.101'); assert.equal(result.gateway, GATEWAY);
  assert.equal(fixture.calls.length, 3);
  assert(fixture.calls.every(call => call.options.redirect === 'manual' && !call.options.headers.Cookie));
  const compressed = fixtureFetch({ config: { paths: { 7: ['appConfig'] }, uuids: { 7: 'd293Q98KpNQbWx+Ij+I9P9' }, versions: { import: [7, 'def34'] } } });
  assert.equal((await resolveDouyinClientVersion(findDouyinGameResources({ env }), compressed)).clientVersion, '1.14.6.101');
  for (const overrides of [
    { manifest: { version: `../${SECRET}` } }, { manifest: { version: '1.2.3', loginServer: `wss://${SECRET}.example/ws` } },
    { manifest: { version: '1.2.3', isServerMaintenance: true } },
    { asset: { config: { version: '1.2.3' }, bundle: { server: 'https://private.example/' } } },
    { config: { paths: { 7: ['appConfig'] }, uuids: { 7: '../../credentials.json' }, versions: { import: [7, 'def34'] } } },
  ]) await assert.rejects(resolveDouyinClientVersion(findDouyinGameResources({ env }), fixtureFetch(overrides)), error => error.code === 'version' && !error.message.includes(SECRET));
});
test('website session is sent only to the documented mini-game code endpoint', async () => {
  const fixture = fixtureFetch();
  const result = await requestDouyinMiniGameCode({ sessionId: SECRET, ...fixture });
  assert.equal(result.code, SECRET); assert.equal(result.isLogin, true); assert.equal(result.session, undefined);
  const call = fixture.calls[0];
  assert.equal(call.url.hostname, 'minigame.zijieapi.com');
  assert.equal(call.url.searchParams.get('appid'), 'tt76340089e939a1bf02');
  assert.equal(call.url.searchParams.get('aid'), '6383');
  assert.equal(call.url.searchParams.get('anonymousid'), '');
  assert.equal(call.options.headers['X-Tma-Host-Sessionid'], SECRET);
  assert.equal(call.options.headers['X-Tma-Host-Deviceid'], '');
  assert.equal(call.options.headers.Cookie, undefined);
  await assert.rejects(requestDouyinMiniGameCode({ sessionId: `${SECRET}\n`, ...fixture }), error => error.code === 'session');
  await assert.rejects(requestDouyinMiniGameCode({ sessionId: SECRET, ...fixtureFetch({ code: { err_no: 7, message: SECRET } }) }), error => error.code === 'code' && !error.message.includes(SECRET));
});
test('publisher transport keeps signed text, parses default JSON, and refuses redirects and credential forwarding', async () => {
  const calls = [];
  const transport = createDouyinSdkTransport({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{"ok":true}', { status: 200, headers: { sign: 'fixture-sign' } });
  } });
  const request = { url: 'https://api.gzxianc.com/api/user/login', method: 'POST', data: 'already-encoded',
    header: { Cookie: SECRET, Authorization: SECRET, 'X-Tma-Host-Sessionid': SECRET, ai: 'fixture-app' }, dataType: 'text' };
  const text = await transport(request);
  assert.equal(text.data, '{"ok":true}'); assert.equal(text.header.sign, 'fixture-sign');
  assert.equal(calls[0].options.body, 'already-encoded');
  assert.equal(JSON.stringify(calls[0]).includes(SECRET), false);
  assert.deepEqual((await transport({ ...request, dataType: undefined })).data, { ok: true });
  for (const url of ['http://api.gzxianc.com/api/init', 'https://api.gzxianc.com.evil.test/', 'https://user:pass@api.gzxianc.com/', 'https://api.gzxianc.com:444/']) {
    await assert.rejects(transport({ ...request, url }), error => error.code === 'network');
  }
  assert.equal(calls.length, 2);
  const redirected = createDouyinSdkTransport({ fetchImpl: async () => new Response('', { status: 302, headers: { location: `https://${SECRET}.example/` } }) });
  await assert.rejects(redirected(request), error => error.code === 'network' && !error.message.includes(SECRET));
});
test('abort and request deadlines terminate even when the injected transport ignores cancellation', async () => {
  const controller = new AbortController();
  const pending = requestDouyinMiniGameCode({ sessionId: SECRET, signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'cancelled');
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(requestDouyinMiniGameCode({ sessionId: SECRET, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), error => error.code === 'timeout');
  } finally { clearTimeout(keepAlive); }
});
test('exchange initializes before requesting fresh code and produces original game field semantics', async () => {
  const fixture = fixtureFetch(), events = [];
  let closed = 0;
  const credential = await exchangeDouyinCredential({ env, sessionId: SECRET, ...fixture, now: () => 1700000000000,
    createSandbox: options => ({
      init: async () => { events.push('init'); assert.equal(fixture.calls.some(call => call.url.hostname === 'minigame.zijieapi.com'), false); },
      login: async () => { events.push('login'); assert.equal((await options.acquireLoginCode()).code, SECRET); return { openId: 'fixture-open', token: SECRET, sign: SECRET, timestamp: '1700000000', isAuth: true, birthday: '' }; },
      getDataInfo: async () => ({ appId: 'fixture-app', channelId: 'fixture-channel', did: 'fixture-did', sc: 'must-not-forward', extc: 'must-not-forward', biz: 'must-not-forward' }),
      close: () => { closed++; },
    }),
  });
  assert.deepEqual(events, ['init', 'login']); assert.equal(closed, 1);
  assert.equal(credential.source, 'douyin'); assert.equal(credential.login.worldId, 0);
  assert.equal(credential.login.eworldParams.timestamp, '1700000000');
  for (const key of ['sc', 'extc', 'biz', 'originVersion', 'deviceModule']) assert.equal(credential.login.eworldClientInfo[key], '');
  assert.equal(credential.login.eworldClientInfo.clientVersion, '1.14.6.101');
  assert.equal(credential.login.eworldClientInfo.platform, '5');
  assert.equal(credential.capturedAt, '2023-11-14T22:13:20.000Z');
});
test('exchange cancels late results, closes SDK, and never surfaces raw SDK secrets', async () => {
  const controller = new AbortController(), gate = deferred(); let closed = 0, entered = false;
  const pending = exchangeDouyinCredential({ env, sessionId: SECRET, signal: controller.signal, ...fixtureFetch(),
    createSandbox: () => ({ init: async () => {}, login: async () => { entered = true; return gate.promise; },
      getDataInfo: async () => { throw Error('must not be called'); }, close: () => { closed++; } }),
  });
  while (!entered) await tick();
  controller.abort(); await assert.rejects(pending, error => error.code === 'cancelled');
  gate.resolve({ token: SECRET }); await tick(); assert.equal(closed, 1);
  await assert.rejects(exchangeDouyinCredential({ env, sessionId: SECRET, ...fixtureFetch(), createSandbox: () => { throw Error(SECRET); } }), error => error.code === 'sdk' && !error.message.includes(SECRET));
  assert.equal(safeDouyinGameAuthError(new Error(SECRET)).message.includes(SECRET), false);
  assert.match(safeDouyinGameAuthError(new DouyinGameAuthError('resources')).message, /CW_DOUYIN_GAME_DIR/);
  const tainted = new DouyinGameAuthError('resources'); tainted.message = SECRET;
  assert.equal(safeDouyinGameAuthError(tainted).message.includes(SECRET), false);
});
test('SDK sandbox runs synthetic code in memory and closes pending operations without leaking callbacks', async () => {
  const source = '__tt_define__("subpackages/minisdk/ttMiniSuperSDK.js",function(){globalThis.EworldSDKManager={init(p){tt.setStorageSync("fixture", "' + SECRET + '");p.onSuccess({ok:true});},login(p){tt.login({success:r=>p.onSuccess({code:r.code}),fail:p.onFailed});},getDataInfo(p){p.onSuccess({appId:"fixture"});}};});';
  const gate = deferred(); let calls = 0;
  const sandbox = createDouyinSdkSandbox({ sdkSource: source, systemInfo: { platform: 'windows' },
    transport: () => { throw Error('No network expected'); }, acquireLoginCode: async () => { calls++; return gate.promise; } });
  assert.equal((await sandbox.init({})).ok, true);
  const pending = sandbox.login(); await tick(); sandbox.close();
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes(SECRET));
  gate.resolve({ code: SECRET }); await tick(); assert.equal(calls, 1);
  await assert.rejects(sandbox.login(), error => error.name === 'AbortError');
});

try {
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(`Douyin game auth selftest passed (${tests.length} offline cases; no live credentials or requests).`);
} finally {
  assert.equal(path.dirname(directory), temporaryRoot);
  assert(path.basename(directory).startsWith('cw-douyin-auth-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
