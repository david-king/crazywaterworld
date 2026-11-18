// Temporary metadata-only observer. Importing this file does not open sockets or change settings.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const STATE_DIR = path.join(ROOT, 'work/douyin-analysis/network/discovery-state');
export const STATE_FILE = path.join(STATE_DIR, 'capture-session.json');
export const BACKUP_FILE = path.join(STATE_DIR, 'proxy-backup.json');
const DEFAULT_GLOBAL_STATE = path.resolve(process.env.CW_CAPTURE_STATE || path.join(process.env.CW_DATA_DIR || path.join(ROOT, 'data'), 'capture-session.json'));
const DEFAULT_GLOBAL_BACKUP = path.resolve(process.env.CW_PROXY_BACKUP || path.join(ROOT, 'certificates/proxy-backup.json'));
const FIELDS = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];
const DEFAULT_DOMAINS = ['douyin.com', 'amemv.com', 'snssdk.com', 'zijieapi.com', 'bytedance.com', 'byte*.com', 'pstatp.com', 'toutiao.com', 'ewan.cn', 'gzxianc.com', 'gzxiancheng.com', 'khlgamen.com', 'cwmob.cn', 'diomasce.com', 'miaogame.cn', 'yiworld.com'];

export function parseOptions(args = []) {
  const o = { run: false, recover: false, seconds: 120, port: 17326, stopFile: null, domains: DEFAULT_DOMAINS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--run') o.run = true;
    else if (a === '--dry') o.run = false;
    else if (a === '--recover') o.recover = true;
    else if (a === '--seconds' || a === '--port') {
      const raw = args[++i];
      if (!/^\d+$/.test(raw || '')) throw new Error('BAD_OPTION');
      const v = Number(raw);
      if (a === '--seconds' && (v < 1 || v > 180)) throw new Error('BAD_DURATION');
      if (a === '--port' && (v < 1024 || v > 65535)) throw new Error('BAD_PORT');
      o[a === '--seconds' ? 'seconds' : 'port'] = v;
    } else if (a === '--domains') {
      o.domains = (args[++i] || '').toLowerCase().split(',');
      if (!o.domains.length || o.domains.some(x => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(x))) throw new Error('BAD_DOMAIN_FILTER');
    } else if (a === '--stop-file') {
      if (!args[i + 1]) throw new Error('BAD_STOP_FILE');
      o.stopFile = path.resolve(args[++i]);
    } else throw new Error('BAD_OPTION');
  }
  return o;
}

export function allowedDomain(host, domains = DEFAULT_DOMAINS) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return domains.some(domain => domain === 'byte*.com'
    ? /(?:^|\.)byte[a-z0-9-]*\.com$/.test(name)
    : name === domain || name.endsWith(`.${domain}`));
}

export function planRouting(current, automatic = {}) {
  if (automatic.unknown) return { safe: false, reason: '无法确认自动代理配置，拒绝覆盖。' };
  if (automatic.pac || automatic.detect) return { safe: false, reason: '存在 PAC 或自动发现配置，拒绝覆盖。' };
  if (Number(current.ProxyEnable) === 1) return { safe: false, reason: '当前有活动上游代理；现有代理工厂不能链式转发，拒绝绕过。' };
  if (Number(current.ProxyEnable ?? 0) !== 0) return { safe: false, reason: 'ProxyEnable 格式未知，拒绝修改。' };
  return { safe: true, mode: 'direct', reason: '当前没有活动上游代理；原 server、enable、override 均保留以供恢复。' };
}

export function domainFromConnect(text) {
  if (typeof text !== 'string' || /[\s/?#@]/.test(text)) return null;
  try {
    const u = new URL(`https://${text}`);
    const port = Number(u.port || 443);
    if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: u.hostname.toLowerCase(), port };
  } catch { return null; }
}

export function validateRecord(r, expectedId) {
  if (!r || r.version !== 1 || r.kind !== 'douyin-domain-discovery' || typeof r.id !== 'string'
      || (expectedId && r.id !== expectedId) || !Number.isInteger(r.ownerPid)
      || !Number.isFinite(r.deadline) || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535) throw new Error('BAD_RECORD');
  if (r.proxy) {
    if (!r.proxy.original || !r.proxy.target || !Array.isArray(r.proxy.pending)
        || r.proxy.pending.some(k => !FIELDS.includes(k))
        || r.proxy.target.ProxyServer !== `127.0.0.1:${r.port}`
        || Number(r.proxy.target.ProxyEnable) !== 1
        || r.proxy.target.ProxyOverride !== r.proxy.original.ProxyOverride) throw new Error('BAD_RECORD');
  }
  return r;
}

export function readAutomatic(settings) {
  try {
    const text = execFileSync('reg', ['query', settings.KEY], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const value = name => text.split(/\r?\n/).map(line => line.match(/^\s*(\S+)\s+REG_\w+\s+(.*)$/)).find(m => m?.[1] === name)?.[2]?.trim();
    let flags = 0;
    try {
      const raw = execFileSync('reg', ['query', `${settings.KEY}\\Connections`, '/v', 'DefaultConnectionSettings'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const hex = raw.match(/REG_BINARY\s+([0-9a-f]+)/i)?.[1];
      if (!hex || hex.length < 24) return { unknown: true };
      flags = Buffer.from(hex, 'hex').readUInt32LE(8);
    } catch { return { unknown: true }; }
    return { pac: Boolean(value('AutoConfigURL')) || Boolean(flags & 4), detect: Number(value('AutoDetect') || 0) !== 0 || Boolean(flags & 8), unknown: false };
  } catch { return { unknown: true }; }
}

export async function loadDependencies() {
  // Isolate state and backup before loading project modules; no account modules are used.
  process.env.CW_CAPTURE_STATE = STATE_FILE;
  process.env.CW_PROXY_BACKUP = BACKUP_FILE;
  process.env.CW_DATA_DIR = STATE_DIR;
  const baseSettings = await import(pathToFileURL(path.join(ROOT, 'src/platform/proxy.mjs')));
  if (path.resolve(baseSettings.BACKUP) !== BACKUP_FILE) throw new Error('MODULE_ALREADY_BOUND');
  const reg = args => execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep all short registry helpers hidden without changing shared project files.
  const settings = { ...baseSettings, readCurrent() {
    const values = {};
    for (const line of reg(['query', baseSettings.KEY]).split(/\r?\n/)) {
      const m = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/);
      if (m) values[m[1]] = m[2].trim();
    }
    return values;
  }, restore(values, names = FIELDS) {
    for (const name of names) {
      if (!FIELDS.includes(name)) throw new Error('BAD_PROXY_FIELD');
      if (values[name] === undefined) {
        if (settings.readCurrent()[name] !== undefined) reg(['delete', baseSettings.KEY, '/v', name, '/f']);
      } else reg(['add', baseSettings.KEY, '/v', name, '/t', name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ', '/d', String(values[name]), '/f']);
    }
    const current = settings.readCurrent();
    if (names.some(k => k === 'ProxyEnable' && current[k] !== undefined && values[k] !== undefined
      ? Number(current[k]) !== Number(values[k]) : current[k] !== values[k])) throw new Error('RESTORE_VERIFY_FAILED');
    return current;
  } };
  const { createCaptureJournal } = await import(pathToFileURL(path.join(ROOT, 'src/capture-recovery.mjs')));
  const { acquireCaptureLock } = await import(pathToFileURL(path.join(ROOT, 'src/platform/capture-lock.mjs')));
  const journal = createCaptureJournal(STATE_FILE);
  return {
    settings, journal, acquireLock: acquireCaptureLock, resume: settings.resumeCaptureProxy,
    routing: () => ({ current: settings.readCurrent(), automatic: readAutomatic(settings) }),
    leftovers: () => [DEFAULT_GLOBAL_STATE, DEFAULT_GLOBAL_BACKUP].filter(p => p !== STATE_FILE && p !== BACKUP_FILE).some(p => fs.existsSync(p)),
    exists: p => Boolean(p && fs.existsSync(p)),
    now: () => Date.now(), runtime: process,
    createProxy: async options => (await import(pathToFileURL(path.join(ROOT, 'tools/mitm-proxy.mjs')))).createProxy(options),
    emit: text => console.log(text),
    domain: record => fs.appendFileSync(path.join(STATE_DIR, 'domains.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 }),
    startWatchdog: id => new Promise((resolve, reject) => {
      const child = fork(path.join(import.meta.dirname, 'domain-watchdog.mjs'), [id], {
        cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const timer = setTimeout(() => reject(new Error('WATCHDOG_START_FAILED')), 5000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('WATCHDOG_START_FAILED')); });
      child.on('message', message => {
        if (message?.ready !== id) return;
        clearTimeout(timer); child.disconnect(); child.unref(); resolve();
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('WATCHDOG_START_FAILED')); });
    }),
  };
}

export function restoreRecord(deps, record, expectedId, { clear = true } = {}) {
  validateRecord(record, expectedId);
  const current = deps.journal.read();
  if (!current || current.id !== record.id) return false;
  if (record.proxy) {
    // Re-evaluate every possibly owned difference, even if a dying writer saved an older
    // pending list. resumeCaptureProxy still leaves unrelated later routing choices intact.
    record.proxy.pending = FIELDS.filter(k => k === 'ProxyEnable'
      ? Number(record.proxy.original[k]) !== Number(record.proxy.target[k])
      : record.proxy.original[k] !== record.proxy.target[k]);
    record.proxy.owned = true;
    deps.resume(deps.settings, record.proxy, {
    onChange(snapshot) { record.proxy = snapshot; deps.journal.write(record); },
    }).restore();
  }
  const final = deps.journal.read();
  if (clear && final?.id === record.id) deps.journal.clear();
  return true;
}

export async function main(args = [], injected) {
  const options = parseOptions(args);
  const d = injected || await loadDependencies();
  if (!injected && process.platform !== 'win32') throw new Error('WINDOWS_ONLY');
  const initial = d.routing();
  const plan = planRouting(initial.current, initial.automatic);
  const old = d.journal.read();
  d.emit(JSON.stringify({ mode: options.run ? (options.recover ? 'recover' : 'run') : 'dry', routing: plan, pendingRecovery: Boolean(old), otherRecoveryPending: d.leftovers(), seconds: options.seconds, port: options.port, preserveOverride: true, tlsDecryption: false, installsCA: false }));
  if (!options.run) return 0;
  if (options.recover) {
    const release = await d.acquireLock();
    try { if (old) restoreRecord(d, old); d.emit('本次研究代理恢复完成。'); return 0; }
    finally { await release(); }
  }
  if (!plan.safe || old || d.leftovers() || d.exists(options.stopFile)) throw new Error('PREFLIGHT_BLOCKED');
  let release, proxy, controller, record, finish;
  let stopped = false, cleanupFailed = false, ignoredConnectCount = 0;
  const done = new Promise(resolve => { finish = resolve; });
  const stop = () => { stopped = true; finish(); };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'].map(name => [name, stop]));
  let timer, fileTimer;
  try {
    release = await d.acquireLock();
    const fresh = d.routing();
    if (!planRouting(fresh.current, fresh.automatic).safe || d.journal.read() || d.leftovers()) throw new Error('PREFLIGHT_CHANGED');
    const original = { ...fresh.current };
    record = { version: 1, kind: 'douyin-domain-discovery', id: randomUUID(), ownerPid: d.runtime.pid,
      startedAt: new Date(d.now()).toISOString(), deadline: d.now() + options.seconds * 1000, port: options.port, proxy: null };
    d.journal.write(record);
    for (const [name, fn] of handlers) d.runtime.on(name, fn);
    timer = setTimeout(stop, options.seconds * 1000);
    if (options.stopFile) fileTimer = setInterval(() => { if (d.exists(options.stopFile)) stop(); }, 250);
    const seen = new Set();
    proxy = await d.createProxy({ port: options.port, rawLogin: true, interceptHosts: [], interceptPorts: [],
      caIsInstalled: () => true,
      certificateFor: () => { throw new Error('TLS_DECRYPTION_FORBIDDEN'); },
      log: (kind, message) => {
        if (kind !== 'connect') return;
        const domain = domainFromConnect(message);
        if (!domain) return;
        if (!allowedDomain(domain.host, options.domains)) { ignoredConnectCount++; return; }
        const key = `${domain.host}:${domain.port}`;
        if (seen.has(key)) return;
        seen.add(key); d.domain({ at: new Date(d.now()).toISOString(), ...domain }); d.emit(`[domain] ${key}`);
      },
    });
    await proxy.listen();
    if (stopped) return 0;
    const target = { ProxyEnable: '0x1', ProxyServer: `127.0.0.1:${options.port}`, ProxyOverride: original.ProxyOverride };
    // Use repository snapshot/restore semantics, but keep the original bypass list.
    const adapter = { ...d.settings, setProxy() {
      d.settings.restore(target, ['ProxyServer', 'ProxyOverride', 'ProxyEnable']);
    } };
    controller = d.resume(adapter, { original, target, ready: false, owned: false, pending: [] }, {
      onChange(snapshot) { record.proxy = snapshot; d.journal.write(record); },
    });
    record.proxy = controller.snapshot(); d.journal.write(record);
    await d.startWatchdog(record.id);
    if (stopped) return 0;
    // Refuse a race with Sparkle/user routing changes while the observer was preparing.
    const before = d.routing();
    if (d.now() >= record.deadline || d.journal.read()?.id !== record.id
      || !planRouting(before.current, before.automatic).safe || FIELDS.some(k => before.current[k] !== original[k])) throw new Error('PREFLIGHT_CHANGED');
    controller.enable();
    d.emit('READY：仅记录 CONNECT 主机与端口；最长 180 秒内恢复。可 Ctrl+C 或创建 stop-file 提前停止。');
    await done;
  } finally {
    clearTimeout(timer); clearInterval(fileTimer);
    // Restore routing before stopping the listener. Leave the journal for retry on failure.
    try { controller?.restore(); } catch { cleanupFailed = true; d.emit('RESTORE_FAILED：恢复记录已保留，请执行 --run --recover。'); }
    try { await proxy?.stop(); } catch { cleanupFailed = true; d.emit('STOP_FAILED'); }
    if (record && !cleanupFailed) {
      try { if (d.journal.read()?.id === record.id) d.journal.clear(); }
      catch { cleanupFailed = true; }
    }
    for (const [name, fn] of handlers) d.runtime.removeListener(name, fn);
    if (release) await release();
  }
  d.emit(cleanupFailed ? '清理未完成。' : '观察已结束，本次代理改动已恢复。');
  d.emit(JSON.stringify({ ignoredConnectCount }));
  return cleanupFailed ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('未执行或已中止：预检/运行失败。若有 pendingRecovery，请使用 --run --recover；不输出原始错误以免包含 URL。');
    process.exitCode = 1;
  });
}
