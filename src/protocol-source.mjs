import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { wechatPackageCandidates, wechatUsersDirectory } from './platform/client-paths.mjs';
import { decrypt, inspectArchive } from '../tools/wxapkg.mjs';

export const PROTO_BUNDLE = path.resolve(import.meta.dirname, '../work/extracted/_src_chunks_/src/chunks/game.js');
export const BUNDLED_PROTOCOL = path.resolve(import.meta.dirname, '../protocol/game.js');
const APPID = 'wx2ea52a972ea18e5e';
const DROP_IN_BUNDLES = [
  path.resolve(import.meta.dirname, '../_src_chunks_.wxapkg'),
  path.resolve(import.meta.dirname, '../protocol/_src_chunks_.wxapkg'),
];

function permissionFailure(error) {
  // The macOS path helper wraps the original filesystem error with guidance.
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    if (cause.code === 'EACCES' || cause.code === 'EPERM') return true;
    seen.add(cause);
  }
  return false;
}

function describeSource(selected, kind) {
  const file = path.resolve(selected);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('协议来源不是文件：' + file);
  fs.accessSync(file, fs.constants.R_OK);
  return Object.freeze({ file, kind, packageVersion: kind === 'wechat' ? path.basename(path.dirname(file)) : null,
    mtimeMs: stat.mtimeMs, size: stat.size, signature: JSON.stringify([file, stat.mtimeMs, stat.size]) });
}

// A repository protocol update starts a fresh cache, so a previous local
// extraction cannot shadow a new checkout's fallback indefinitely.
let bundledHash;
function packageCacheFile() {
  const stat = fs.statSync(BUNDLED_PROTOCOL, { throwIfNoEntry: false });
  if (stat && (!bundledHash || bundledHash.mtimeMs !== stat.mtimeMs || bundledHash.size !== stat.size)) {
    bundledHash = { mtimeMs: stat.mtimeMs, size: stat.size,
      hash: createHash('sha256').update(fs.readFileSync(BUNDLED_PROTOCOL)).digest('hex') };
  }
  const root = process.env.CW_DATA_DIR || path.resolve(import.meta.dirname, '../data');
  return path.resolve(root, 'protocol', stat ? bundledHash.hash : 'unbundled', 'game.js');
}

export function cachePackageProtocol(code) {
  const file = packageCacheFile();
  try { if (fs.readFileSync(file, 'utf8') === code) return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, code, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function* fallbackSources() {
  for (const file of DROP_IN_BUNDLES) yield [file, 'drop-in'];
  yield [packageCacheFile(), 'cached'];
  yield [PROTO_BUNDLE, 'extracted'];
  yield [BUNDLED_PROTOCOL, 'bundled'];
}

// Describe the selected source without evaluating game code. A running
// connection keeps its loaded protocol; new connections can compare this
// identity to detect a newly downloaded package or an edited explicit file.
export function protocolSourceInfo(bundlePath) {
  const explicit = bundlePath || process.env.CW_PROTO_BUNDLE;
  if (explicit) return describeSource(explicit, 'explicit');
  let cacheError;
  try {
    const cached = wechatPackageCandidates(APPID, { includeIncomplete: true })[0];
    if (cached) return describeSource(cached, 'wechat');
  } catch (error) {
    // A main package may appear before its optional protocol subpackage.
    if (!permissionFailure(error) && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    cacheError = error;
  }
  const locations = [wechatUsersDirectory()];
  for (const [file, kind] of fallbackSources()) {
    locations.push(file);
    try { return describeSource(file, kind); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error([
    permissionFailure(cacheError) ? cacheError.message : '缺少协议文件。',
    '已搜索：', ...locations.map(file => '  ' + file),
    '请恢复仓库中的 protocol/game.js，或把 _src_chunks_.wxapkg 放到程序根目录或 protocol/ 子目录。',
    '也可设置 CW_PROTO_BUNDLE 指向自己的 _src_chunks_.wxapkg 或解包后的 src/chunks/game.js。',
  ].join('\n'), cacheError ? { cause: cacheError } : undefined);
}

function readBundle(file) {
  const input = fs.readFileSync(file);
  if (!/\.wxapkg$/i.test(file)) return input.toString('utf8');
  const { data } = decrypt(APPID, input);
  const entry = inspectArchive(data).files.find(item => item.relativePath === 'src/chunks/game.js');
  if (!entry) throw new Error(file + ' 中缺少 src/chunks/game.js，请使用 _src_chunks_.wxapkg');
  return data.toString('utf8', entry.off, entry.off + entry.size);
}

export function readProtocolSource(bundlePath) {
  return readBundle(protocolSourceInfo(bundlePath).file);
}
