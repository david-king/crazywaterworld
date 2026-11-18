// Offline fixtures only: no listener, DNS, registry, system proxy or certificate operations.
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { createMetadataSampler, SAMPLE_LIMIT } from './metadata-sampler.mjs';
import { createHttpObserver, OBSERVED_HOST } from './https-observer.mjs';

const outputs = [], sampler = createMetadataSampler({ emit: value => outputs.push(value) });
const secret = 'PRIVATE_FAKE_CODE_99431';
const value = { data: { code: secret, anonymousCode: secret, session_key: 'PRIVATE_SESSION',
  isLogin: true, error_code: 0, account: 99887766, nested: [{ access_token: 'PRIVATE_TOKEN' }] }, message: 'PRIVATE_MESSAGE' };
const body = Buffer.from(JSON.stringify(value));
const base = { id: 1, direction: 'response', host: OBSERVED_HOST, url: '/mgplatform/api/apps/login?app_id=PRIVATE_APP&token=PRIVATE_QUERY', method: 'POST', status: 200,
  headers: { 'content-type': 'application/json', authorization: 'Bearer PRIVATE_AUTH', cookie: 'PRIVATE_COOKIE', 'set-cookie': ['PRIVATE_SETCOOKIE'], location: 'https://PRIVATE_LOCATION.invalid/' } };
function sample(bytes, headers = {}, source = sampler) { const capture = source.begin({ ...base, headers: { ...base.headers, ...headers } }); capture.add(bytes.subarray(0, 5)); capture.add(bytes.subarray(5)); capture.end(); capture.end(); }
sample(body);
assert.equal(outputs.length, 1);
assert.deepEqual(outputs[0].queryKeys, ['app_id', 'token']);
assert(outputs[0].headerNames.includes('set-cookie'));
assert.equal(outputs[0].fields.find(f => f.path === '$.data.code').length, secret.length);
assert.equal(outputs[0].fields.find(f => f.path === '$.data.isLogin').value, true);
assert.equal(outputs[0].fields.find(f => f.path === '$.data.error_code').value, 0);
assert.equal(outputs[0].fields.find(f => f.path === '$.data.account').value, undefined);
assert.equal(outputs[0].fields.find(f => f.path === '$.data.code').hmac, outputs[0].fields.find(f => f.path === '$.data.anonymousCode').hmac);
assert(outputs[0].credentialFields.includes('$.data.session_key'));
assert(!JSON.stringify(outputs).includes('PRIVATE_'));
assert(!JSON.stringify(outputs).includes('99887766'));
sample(gzipSync(body), { 'content-encoding': 'gzip' });
sample(brotliCompressSync(body), { 'content-encoding': 'br' });
assert.equal(outputs[1].sample, 'parsed'); assert.equal(outputs[2].sample, 'parsed');
assert.equal(outputs[1].fields.find(f => f.path === '$.data.code').hmac, outputs[0].fields.find(f => f.path === '$.data.code').hmac);
const fresh = [], freshSampler = createMetadataSampler({ emit: x => fresh.push(x) }); sample(body, {}, freshSampler);
assert.notEqual(fresh[0].fields.find(f => f.path === '$.data.code').hmac, outputs[0].fields.find(f => f.path === '$.data.code').hmac);
sample(Buffer.alloc(SAMPLE_LIMIT + 1)); assert.equal(outputs.at(-1).sample, 'compressed_limit');
sample(gzipSync(Buffer.alloc(SAMPLE_LIMIT + 1, 65)), { 'content-encoding': 'gzip' }); assert.equal(outputs.at(-1).sample, 'unparsed_or_decode_limit');
sample(brotliCompressSync(Buffer.alloc(SAMPLE_LIMIT + 1, 65)), { 'content-encoding': 'br' }); assert.equal(outputs.at(-1).sample, 'unparsed_or_decode_limit');
sample(Buffer.from('PRIVATE_INVALID_JSON')); assert.equal(outputs.at(-1).sample, 'unparsed_or_decode_limit');
sample(Buffer.from('code=PRIVATE_FORM&session=PRIVATE_SESSION'), { 'content-type': 'application/x-www-form-urlencoded' });
assert(outputs.at(-1).fields.some(f => f.path === '$.code'));
assert(!JSON.stringify(outputs).includes('PRIVATE_'));
const errors = createMetadataSampler({ emit: () => { throw new Error('PRIVATE_EMIT_ERROR'); } }); assert.doesNotThrow(() => sample(body, {}, errors));
const stream = new PassThrough(), received = [], capture = sampler.begin(base);
stream.on('data', chunk => { capture.add(chunk); received.push(Buffer.from(chunk)); });
stream.on('end', () => capture.end());
await new Promise(resolve => { stream.on('end', resolve); stream.end(body); });
assert.deepEqual(Buffer.concat(received), body);
assert.deepEqual(body, Buffer.from(JSON.stringify(value)), 'sampling must not alter forwarded buffers');
let certificateCalls = 0;
const options = { certificateFor() { certificateCalls++; throw new Error('must not run'); }, caIsInstalled: () => false };
assert.throws(() => createHttpObserver({ ...options, interceptHosts: ['example.com'] }), /HOST_SCOPE_MISMATCH/);
assert.throws(() => createHttpObserver({ ...options, interceptPorts: [80] }), /HOST_SCOPE_MISMATCH/);
assert.throws(() => createHttpObserver({ ...options, upstreamCa: 'untrusted' }), /UPSTREAM_TRUST_OVERRIDE_FORBIDDEN/);
const observer = createHttpObserver(options); await assert.rejects(observer.listen(), /CA_NOT_INSTALLED/); await observer.stop();
assert.equal(certificateCalls, 0);
console.log('PASS: field-only metadata, secret/header/query redaction, same-run HMAC correlation, different-run unlinkability, gzip/br limits, form bodies, sampling failure isolation, unchanged byte streams, exact host scope, no trust overrides. No network or system modifications.');
