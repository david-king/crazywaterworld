// Preparation only by default. This observer requires explicit --run --confirm-ca <host>.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { ROOT, planRouting, readAutomatic } from './domain-discovery.mjs';

export const HOST = 'minigame.zijieapi.com';
export const DIR = path.join(ROOT, 'work/douyin-analysis/network/https-state');
export const CA_DIR = path.join(DIR, 'certificates');
export const FILE = path.join(DIR, 'capture-session.json');
export const META_FILE = path.join(DIR, 'owner.json');
export const STOP_FILE = path.join(DIR, 'stop');
const BACKUP_FILE = path.join(DIR, 'proxy-backup.json');
const FIELDS = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

export function parse(args = []) {
  const o = { run: false, recover: false, confirm: false, seconds: 120, port: 17327, stopFile: STOP_FILE };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--run') o.run = true;
    else if (a === '--dry') o.run = false;
    else if (a === '--recover') o.recover = true;
    else if (a === '--confirm-ca') o.confirm = args[++i] === HOST;
    else if (a === '--seconds' || a === '--port') {
      const raw = args[++i]; if (!/^\d+$/.test(raw || '')) throw new Error('BAD_OPTION');
      const v = Number(raw); if (a === '--seconds' ? v < 1 || v > 180 : v < 1024 || v > 65535) throw new Error('BAD_LIMIT');
      o[a === '--seconds' ? 'seconds' : 'port'] = v;
    } else if (a === '--stop-file' && args[i + 1]) o.stopFile = path.resolve(args[++i]);
    else throw new Error('BAD_OPTION');
  }
  return o;
}

export function preserveOverride(base, original, port, guard = () => {}) {
  const server = `127.0.0.1:${port}`;
  return { ...base,
    readCurrent() {
      const current = base.readCurrent();
      // The shared controller expects its fixed <local> target. Only translate our
      // unchanged real bypass list; a later user bypass change remains visible.
      if (Number(current.ProxyEnable) === 1 && current.ProxyServer === server
        && current.ProxyOverride === original.ProxyOverride) return { ...current, ProxyOverride: '<local>' };
      return current;
    },
    setProxy(host, value) {
      guard(); if (host !== '127.0.0.1' || value !== port) throw new Error('BAD_TARGET');
      base.restore({ ProxyServer: server, ProxyOverride: original.ProxyOverride, ProxyEnable: '0x1' }, ['ProxyServer', 'ProxyOverride', 'ProxyEnable']);
    },
  };
}

export async function load() {
  process.env.CW_CA_DIR = CA_DIR; process.env.CW_CAPTURE_STATE = FILE;
  process.env.CW_PROXY_BACKUP = BACKUP_FILE; process.env.CW_DATA_DIR = DIR;
  const settings = await import(pathToFileURL(path.join(ROOT, 'src/platform/proxy.mjs')));
  const ca = await import(pathToFileURL(path.join(ROOT, 'src/platform/certificates.mjs')));
  if (path.resolve(settings.BACKUP) !== BACKUP_FILE || path.resolve(ca.CA_DIR) !== CA_DIR) throw new Error('WRONG_MODULE_SCOPE');
  const { createCaptureJournal } = await import(pathToFileURL(path.join(ROOT, 'src/capture-recovery.mjs')));
  const { createCaptureController } = await import(pathToFileURL(path.join(ROOT, 'src/capture.mjs')));
  const { acquireCaptureLock } = await import(pathToFileURL(path.join(ROOT, 'src/platform/capture-lock.mjs')));
  const journal = createCaptureJournal(FILE), meta = createCaptureJournal(META_FILE);
  return { settings, ca, journal, meta, createController: createCaptureController, acquireLock: acquireCaptureLock,
    now: () => Date.now(), runtime: process, exists: p => fs.existsSync(p),
    routing: () => ({ current: settings.readCurrent(), automatic: readAutomatic(settings) }),
    otherPending: () => [path.join(ROOT, 'data/capture-session.json'), path.join(ROOT, 'certificates/proxy-backup.json'), path.join(ROOT, 'work/douyin-analysis/network/discovery-state/capture-session.json')].some(p => fs.existsSync(p)),
    emit: text => console.log(text),
    factory: async () => (await import('./https-observer.mjs')).createHttpObserver,
    metadata: row => fs.appendFileSync(path.join(DIR, 'http-metadata.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 }),
    touchStop: () => fs.writeFileSync(STOP_FILE, 'stop\n'),
    removeStop: () => fs.rmSync(STOP_FILE, { force: true }),
    startWatchdog: id => new Promise((resolve, reject) => {
      const child = fork(path.join(import.meta.dirname, 'https-watchdog.mjs'), [id], { cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => reject(new Error('WATCHDOG_START_FAILED')), 5000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('WATCHDOG_START_FAILED')); });
      child.on('message', m => { if (m?.ready === id) { clearTimeout(timer); child.disconnect(); child.unref(); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('WATCHDOG_START_FAILED')); });
    }),
  };
}

export function validateOwner(owner, expected) {
  if (!owner || owner.version !== 1 || owner.kind !== 'douyin-https-observer' || (expected && owner.id !== expected)
    || owner.host !== HOST || !Number.isInteger(owner.ownerPid) || !Number.isFinite(owner.deadline)
    || !Number.isInteger(owner.port) || owner.port < 1024 || owner.port > 65535 || !owner.original) throw new Error('BAD_OWNER');
  if (owner.caThumbprint && !/^[a-f0-9]{40}$/i.test(owner.caThumbprint)) throw new Error('BAD_CA');
  return owner;
}

export function recoverOwned(d, owner, { clear = true } = {}) {
  validateOwner(owner);
  if (d.meta.read()?.id !== owner.id) return false;
  const record = d.journal.read();
  if (record?.proxy) {
    if (record.port !== owner.port || record.proxy.target?.ProxyServer !== `127.0.0.1:${owner.port}`) throw new Error('BAD_CAPTURE_TARGET');
    const proxy = { ...record.proxy, original: owner.original,
      target: { ProxyEnable: '0x1', ProxyServer: `127.0.0.1:${owner.port}`, ProxyOverride: owner.original.ProxyOverride },
      owned: true, pending: FIELDS.filter(k => k === 'ProxyEnable' ? Number(owner.original[k]) !== 1 : owner.original[k] !== (k === 'ProxyServer' ? `127.0.0.1:${owner.port}` : owner.original[k])) };
    d.settings.resumeCaptureProxy(d.settings, proxy).restore();
  }
  // Exact fingerprint only. Never enumerate/delete other current-user CAs.
  if (owner.caCreated && owner.caThumbprint) {
    if (d.ca.isInstalled(owner.caThumbprint)) d.ca.uninstallCa(owner.caThumbprint);
    if (d.ca.isInstalled(owner.caThumbprint)) throw new Error('CA_STILL_INSTALLED');
  }
  if (!clear) return true;
  if ((owner.caCreated || owner.caCreationStarted) && d.exists(CA_DIR)) {
    if (path.resolve(d.ca.CA_DIR) !== CA_DIR || (owner.caFingerprint && d.ca.caFingerprint() !== owner.caFingerprint)) throw new Error('CA_FILES_CHANGED');
    d.ca.removeCaFiles();
  }
  if (d.meta.read()?.id === owner.id) { d.journal.clear(); d.meta.clear(); d.removeStop(); }
  return true;
}

export async function main(args = [], injected) {
  const o = parse(args), d = injected || await load();
  const route = d.routing(), plan = planRouting(route.current, route.automatic);
  const prior = d.meta.read(), pending = Boolean(prior || d.journal.read());
  d.emit(JSON.stringify({ mode: o.run ? (o.recover ? 'recover' : 'run') : 'dry', host: HOST, port: 443,
    proxyPort: o.port, seconds: o.seconds, routingSafe: plan.safe, pendingRecovery: pending,
    otherPending: d.otherPending(), existingPrivateCaFiles: d.exists(CA_DIR), consentProvided: o.confirm,
    caScope: 'new temporary CurrentUser Root certificate; exact own thumbprint only', output: 'sanitized metadata only' }));
  if (!o.run) return 0;
  if (o.recover) {
    const release = await d.acquireLock();
    try { if (prior) recoverOwned(d, prior); else if (pending) throw new Error('OWNER_MISSING'); return 0; }
    finally { await release(); }
  }
  if (!o.confirm) throw new Error('CA_CONSENT_REQUIRED');
  if (!plan.safe || pending || d.otherPending() || d.exists(CA_DIR) || d.exists(o.stopFile)) throw new Error('PREFLIGHT_BLOCKED');
  const factory = await d.factory();
  const owner = { version: 1, kind: 'douyin-https-observer', id: randomUUID(), host: HOST, port: o.port,
    ownerPid: d.runtime.pid, deadline: d.now() + o.seconds * 1000, original: route.current, caCreated: false };
  let controller, poll, stopReason = '完成', startupError, cleaned = false, finishing = false, finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const guard = () => {
    const current = d.routing();
    if (d.now() >= owner.deadline || d.meta.read()?.id !== owner.id
      || !planRouting(current.current, current.automatic).safe
      || FIELDS.some(k => current.current[k] !== owner.original[k])) throw new Error('PREFLIGHT_CHANGED');
  };
  d.meta.write(owner);
  try {
    await d.startWatchdog(owner.id);
    guard();
    const ca = { ...d.ca,
      initCa() {
        d.emit('STAGE CA_INIT');
        guard(); owner.caCreationStarted = true; d.meta.write(owner); const result = d.ca.initCa();
        if (!result?.created) throw new Error('CA_MUST_BE_NEW');
        owner.caCreated = true; owner.caThumbprint = d.ca.caThumbprint(); owner.caFingerprint = d.ca.caFingerprint(); d.meta.write(owner);
        return result;
      },
      prepareLeaf: () => { d.emit('STAGE LEAF_PREPARE'); return d.ca.prepareLeaf(HOST); },
      installCa: async options => {
        guard(); d.emit('STAGE CA_TRUST_WAIT');
        try { const result = await d.ca.installCa(options); d.emit('STAGE CA_TRUST_OK'); return result; }
        catch (error) { d.emit('STAGE CA_TRUST_FAILED'); throw error; }
      },
    };
    controller = d.createController({ ca, journal: d.journal, acquireLock: d.acquireLock,
      proxySettings: preserveOverride(d.settings, owner.original, o.port, guard), process: d.runtime,
      createProxy: () => {
        d.emit('STAGE HTTP_FACTORY');
        const observer = factory({ port: o.port, interceptHosts: [HOST], interceptPorts: [443],
          certificateFor: host => { if (host !== HOST) throw new Error('HOST_FORBIDDEN'); return ca.leafFor(HOST); },
          caIsInstalled: () => ca.isInstalled(), onMetadata: d.metadata, log: () => {},
        });
        if (observer.listen) {
          const listen = observer.listen.bind(observer);
          observer.listen = async () => { d.emit('STAGE PROXY_LISTEN'); await listen(); d.emit('STAGE PROXY_LISTEN_OK'); };
        }
        return observer;
      },
    });
    poll = setInterval(() => {
      if (!finishing && (d.now() >= owner.deadline || d.exists(o.stopFile) || d.exists(STOP_FILE))) {
        finishing = true; stopReason = '截止或停止文件'; void controller.stopCapture(stopReason).then(finish, finish);
      }
    }, 250);
    const state = await controller.startCapture({ platform: 'douyin', port: o.port, keepCa: false, timeoutMs: Math.max(1, owner.deadline - d.now()), onLog: line => {
      // Lifecycle messages contain no HTTP payloads; emit only fixed stages.
      if (line.includes('采集已就绪')) d.emit(`READY：只解密 ${HOST}:443。`);
    } });
    if (state.phase !== 'waiting') { d.emit(`START_STATE ${['idle', 'error', 'starting', 'ca', 'listening', 'proxy', 'stopping'].includes(state.phase) ? state.phase : 'unknown'}`); throw new Error('START_FAILED'); }
    await finished;
  } catch (error) { startupError = error; }
  finally {
    clearInterval(poll);
    if (controller) await controller.stopCapture(stopReason);
    // Recheck own exact CA after the shared controller finishes; also handles init failure.
    try { recoverOwned(d, owner); cleaned = true; } catch { d.emit('RECOVERY_REQUIRED：本次恢复记录已保留。'); }
  }
  if (startupError || !cleaned) throw new Error('OBSERVATION_FAILED');
  d.emit('单域名观察已停止，原代理已恢复，本次新 CA 与证书材料已清理。');
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('未执行或观察失败；未满足确认/预检条件时不会安装 CA。若存在 pendingRecovery，执行 --run --recover。'); process.exitCode = 1;
  });
}
