// Mock lifecycle only; no network listener, certificate operation, or registry operation.
import assert from 'node:assert/strict';
import { parse, main, HOST, CA_DIR, preserveOverride, recoverOwned } from './https-observe.mjs';
import { resumeCaptureProxy } from '../../src/platform/proxy.mjs';

assert.equal(parse([]).run, false);
assert.equal(parse(['--run', '--confirm-ca', HOST]).confirm, true);
assert.equal(parse(['--run', '--confirm-ca', 'other.example']).confirm, false);
assert.throws(() => parse(['--seconds', '181']));

function fixture({ failedInstall = false, existing = false, late = false } = {}) {
  const original = { ProxyEnable: '0x0', ProxyServer: '127.0.0.1:7890', ProxyOverride: '10.*;<local>' };
  let current = { ...original }, owner = null, journal = null, files = existing, trusted = false, stop = false, clock = Date.now();
  const events = [];
  const settings = { resumeCaptureProxy, readCurrent: () => ({ ...current }),
    backup() {}, removeBackup() {}, restore(v, keys) { for (const k of keys) current[k] = v[k]; events.push('restore-route'); } };
  const ca = { CA_DIR, CA_CRT: `${CA_DIR}/ca.crt`,
    initCa() { events.push('init'); files = true; return { created: true }; },
    caThumbprint: () => 'a'.repeat(40), caFingerprint: () => 'own-fingerprint',
    prepareLeaf(host) { assert.equal(host, HOST); events.push('leaf'); },
    isInstalled: () => trusted, leafFor: host => { assert.equal(host, HOST); return {}; },
    async installCa() { events.push('install'); trusted = true; if (failedInstall) throw new Error('installation failed after trust write'); },
    uninstallCa(fp) { assert.equal(fp, 'a'.repeat(40)); events.push('uninstall'); trusted = false; },
    removeCaFiles() { events.push('remove-files'); files = false; },
  };
  const d = { settings, ca, now: () => clock, runtime: { pid: 1234 },
    journal: { read: () => journal && structuredClone(journal), write: x => { journal = structuredClone(x); }, clear: () => { journal = null; } },
    meta: { read: () => owner && structuredClone(owner), write: x => { owner = structuredClone(x); }, clear: () => { owner = null; } },
    routing: () => ({ current: { ...current }, automatic: {} }), otherPending: () => false,
    exists: p => p === CA_DIR ? files : stop, removeStop() { stop = false; }, emit() {}, metadata() {},
    acquireLock: async () => async () => {},
    factory: async () => args => { assert.deepEqual(args.interceptHosts, [HOST]); assert.deepEqual(args.interceptPorts, [443]); events.push('factory'); return {}; },
    startWatchdog: async () => { events.push('watchdog'); if (late) clock = owner.deadline + 1; },
    createController: dependencies => ({
      async startCapture(options) {
        assert.equal(options.keepCa, false); assert(options.timeoutMs <= 180000);
        dependencies.createProxy({ interceptHosts: ['wrong-gateway.example'] });
        dependencies.ca.initCa(); dependencies.ca.prepareLeaf('wrong-gateway.example');
        await dependencies.ca.installCa({});
        const target = { ProxyEnable: '0x1', ProxyServer: `127.0.0.1:${options.port}`, ProxyOverride: '<local>' };
        d.journal.write({ port: options.port, proxy: { original, target, owned: true, ready: true, pending: ['ProxyEnable', 'ProxyServer', 'ProxyOverride'] } });
        dependencies.proxySettings.setProxy('127.0.0.1', options.port);
        assert.equal(current.ProxyOverride, original.ProxyOverride);
        assert.equal(dependencies.proxySettings.readCurrent().ProxyOverride, '<local>');
        stop = true; return { phase: 'waiting' };
      },
      async stopCapture() { events.push('controller-stop'); },
    }),
  };
  return { d, events, original, get current() { return current; }, get owner() { return owner; }, get trusted() { return trusted; }, get files() { return files; } };
}
const dry = fixture(); assert.equal(await main([], dry.d), 0); assert.deepEqual(dry.events, []);
const noConsent = fixture(); await assert.rejects(main(['--run'], noConsent.d)); assert.deepEqual(noConsent.events, []);
const preexisting = fixture({ existing: true }); await assert.rejects(main(['--run', '--confirm-ca', HOST], preexisting.d)); assert.deepEqual(preexisting.events, []);
const run = fixture(); assert.equal(await main(['--run', '--confirm-ca', HOST], run.d), 0);
assert.deepEqual(run.current, run.original); assert.equal(run.trusted, false); assert.equal(run.files, false); assert.equal(run.owner, null);
assert(run.events.indexOf('watchdog') < run.events.indexOf('init'));
assert(run.events.indexOf('uninstall') < run.events.indexOf('remove-files'));
const failed = fixture({ failedInstall: true }); await assert.rejects(main(['--run', '--confirm-ca', HOST], failed.d));
assert.equal(failed.trusted, false); assert.equal(failed.files, false); assert.equal(failed.owner, null);
const expired = fixture({ late: true }); await assert.rejects(main(['--run', '--confirm-ca', HOST], expired.d)); assert(!expired.events.includes('init'));
let current = { ProxyEnable: '0x1', ProxyServer: '127.0.0.1:17327', ProxyOverride: 'user-changed' };
const adapter = preserveOverride({ readCurrent: () => current }, { ProxyOverride: 'original' }, 17327);
assert.equal(adapter.readCurrent().ProxyOverride, 'user-changed', 'do not hide another bypass change');
console.log('PASS: default dry, explicit host consent, existing private-CA refusal, exact host/port factory, watchdog-before-CA, override preservation, failed-install cleanup, deadline guard, exact thumbprint removal. No real listeners, trust changes, traffic, or registry writes.');
