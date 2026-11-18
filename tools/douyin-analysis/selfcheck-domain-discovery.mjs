// Fully offline: fake registry, fake proxy, fake watchdog. No real listeners, CA, or proxy changes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { main, parseOptions, planRouting, domainFromConnect, allowedDomain, restoreRecord } from './domain-discovery.mjs';
import { resumeCaptureProxy } from '../../src/platform/proxy.mjs';

assert.equal(parseOptions([]).run, false);
assert.throws(() => parseOptions(['--run', '--seconds', '181']));
assert.equal(planRouting({ ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7890' }).safe, false);
assert.equal(planRouting({ ProxyEnable: '0x0' }, { pac: true }).safe, false);
assert.equal(planRouting({ ProxyEnable: '0x0' }, { detect: true }).safe, false);
assert.equal(planRouting({ ProxyEnable: '0x0' }, { unknown: true }).safe, false);
assert.deepEqual(domainFromConnect('EXAMPLE.com:443'), { host: 'example.com', port: 443 });
assert.equal(domainFromConnect('example.com:443/?token=SECRET'), null);
assert.equal(domainFromConnect('u:p@example.com:443'), null);
assert.equal(allowedDomain('api.amemv.com'), true);
assert.equal(allowedDomain('lf.bytecnd.com'), true);
assert.equal(allowedDomain('douyin.com.evil.example'), false);
assert.equal(allowedDomain('example.com'), false);

function fixture({ active = false, failRestore = false, changeWhilePreparing = false, expireWhilePreparing = false } = {}) {
  const original = { ProxyEnable: active ? '0x1' : '0x0', ProxyServer: '127.0.0.1:7890', ProxyOverride: '10.*;192.168.*;<local>' };
  let current = { ...original }, saved = null, backup = null, log = [], domains = [], events = [], clock = Date.now();
  const runtime = new EventEmitter(); runtime.pid = 12345;
  const settings = {
    readCurrent: () => ({ ...current }),
    backup: value => { backup = { ...value }; events.push('backup'); },
    removeBackup: () => { backup = null; },
    restore: (values, fields) => {
      if (failRestore && fields.length === 1 && values.ProxyEnable === '0x0') throw new Error('fake restore failure');
      for (const k of fields) { if (values[k] === undefined) delete current[k]; else current[k] = values[k]; }
      events.push(fields.includes('ProxyServer') ? 'route-write' : 'restore');
    },
  };
  const d = { settings, runtime, now: () => clock, resume: resumeCaptureProxy,
    journal: { read: () => saved && structuredClone(saved), write: r => { saved = structuredClone(r); }, clear: () => { saved = null; } },
    routing: () => ({ current: { ...current }, automatic: {} }), leftovers: () => false, exists: () => false,
    acquireLock: async () => { events.push('lock'); return async () => { events.push('unlock'); }; },
    emit: s => log.push(s), domain: r => domains.push(r),
    createProxy: async options => {
      assert.equal(options.rawLogin, true); assert.deepEqual(options.interceptHosts, []); assert.deepEqual(options.interceptPorts, []);
      assert.throws(() => options.certificateFor());
      return { listen: async () => {
        events.push('listen'); options.log('connect', 'api.douyin.com:443'); options.log('connect', 'api.douyin.com:443');
        options.log('connect', 'unrelated-private.example:443');
        options.log('http', 'GET https://example.com/path?token=SECRET'); options.log('connect', 'bad/?token=SECRET');
      }, stop: async () => { events.push('stop'); } };
    },
    startWatchdog: async () => {
      events.push('watchdog');
      if (expireWhilePreparing) { clock = saved.deadline + 1; saved = null; }
      else if (changeWhilePreparing) current = { ProxyEnable: '0x1', ProxyServer: '127.0.0.1:7891', ProxyOverride: 'user' };
      else setTimeout(() => runtime.emit('SIGINT'), 5);
    },
  };
  return { d, original, get current() { return current; }, get saved() { return saved; }, get backup() { return backup; }, log, domains, events };
}
const dry = fixture(); assert.equal(await main([], dry.d), 0); assert.deepEqual(dry.events, []);
const run = fixture(); assert.equal(await main(['--run'], run.d), 0);
assert.deepEqual(run.current, run.original); assert.equal(run.saved, null); assert.equal(run.backup, null);
assert.equal(run.domains.length, 1); assert(!run.log.join('').includes('SECRET'));
assert(!run.log.join('').includes('unrelated-private.example'));
assert(run.events.indexOf('listen') < run.events.indexOf('route-write'));
assert(run.events.indexOf('watchdog') < run.events.indexOf('route-write'));
assert(run.events.lastIndexOf('restore') < run.events.indexOf('stop'));
const active = fixture({ active: true }); await assert.rejects(main(['--run'], active.d)); assert.deepEqual(active.events, []);
const race = fixture({ changeWhilePreparing: true }); await assert.rejects(main(['--run'], race.d));
assert.equal(race.current.ProxyServer, '127.0.0.1:7891'); assert(!race.events.includes('backup'));
const expiry = fixture({ expireWhilePreparing: true }); await assert.rejects(main(['--run'], expiry.d));
assert.deepEqual(expiry.current, expiry.original); assert(!expiry.events.includes('backup')); assert(!expiry.events.includes('route-write'));
const failure = fixture({ failRestore: true }); assert.equal(await main(['--run'], failure.d), 1); assert(failure.saved?.proxy?.owned);
const failedRecord = failure.saved;
failure.d.settings.restore = (values, fields) => { for (const k of fields) failure.current[k] = values[k]; };
assert.equal(restoreRecord(failure.d, failedRecord, failedRecord.id, { clear: false }), true); assert.deepEqual(failure.current, failure.original);
assert(failure.saved, 'watchdog keeps journal while owner may still write');
failure.current.ProxyEnable = '0x1'; failure.current.ProxyServer = '127.0.0.1:17326';
assert.equal(restoreRecord(failure.d, failure.saved, failedRecord.id), true); assert.deepEqual(failure.current, failure.original);
assert.equal(failure.saved, null);
console.log('PASS: dry, no-CA options, upstream/PAC guards, override preservation, watchdog ordering, Ctrl+C cleanup, changed-routing preservation, failure recovery, metadata redaction. No real network or system changes.');
