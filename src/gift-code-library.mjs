import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DATA_DIR } from './accounts.mjs';
import { initialGiftCodeCatalog } from './gift-code-catalog.mjs';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { articleRule, codePattern, parseGiftCodeArticle, upgradeGiftRule, wikiRule } from './gift-code-extraction.mjs';
import { channelConfig, fetchChannelBody, parseChannelBody } from './gift-code-channel.mjs';

export { parseGiftCodeArticle };
export const GIFT_CODE_SOURCE = 'https://m.ali213.net/news/gl2602/1747967.html';
export const GIFT_CODE_WIKI = 'https://fkssj.game-wiki.cn/api/public/codes';
const isDefaultChannel = id => id === 'ali213' || id === 'game-wiki';
export const giftDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const expiredDate = (date, now) => Boolean(date) && Date.parse(date + 'T23:59:59.999+08:00') < now;
export const hasGiftCodeHistory = row => row.status === 'skipped' ? String(row.detail ?? '').includes('已有兑换记录')
  : row.status === 'rejected' ? row.promptName !== 'GIFT_CODE_TOO_MANY_REQUESTS' && row.detail !== '请求过于频繁'
    : ['success', 'used', 'unknown', 'sending', 'queued'].includes(row.status);

function normalizeExpiry(value, now) {
  if (value === undefined || value === null || value === '') return null;
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value || expiredDate(value, now)) {
    throw new Error('到期日期无效或已经过期');
  }
  return value;
}

// The bundled catalog remains available offline. Manual entries and explicit
// server-expiry tombstones share one transaction so a rejected batch saves none.
export function createGiftCodeLibrary({ directory = DATA_DIR, now = Date.now, catalog = initialGiftCodeCatalog, fetcher } = {}) {
  const file = path.join(directory, 'shared-gift-codes.json');
  const catalogFile = path.join(directory, 'public-gift-codes.json');
  const preferenceFile = path.join(directory, 'gift-code-preferences.json');
  const fetching = new Map();
  const read = () => {
    const data = readJson(file, { version: 1, codes: [], expired: [] });
    if (data?.version !== 1 || !Array.isArray(data.codes) || !Array.isArray(data.expired ?? [])) throw Error('共享礼包码数据库无效');
    if (data.codes.some(row => !row || typeof row.code !== 'string' || !codePattern.test(row.code)
      || row.expiresAt != null && (typeof row.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiresAt)))) {
      throw Error('共享礼包码数据库无效');
    }
    if ((data.expired ?? []).some(row => !row || typeof row.code !== 'string')) throw Error('共享礼包码下架记录无效');
    return { ...data, expired: data.expired ?? [] };
  };
  function recordExpired(codes, reason = '游戏服务器明确返回礼包码已过期') {
    const missingCodes = state => {
      const expired = new Set(state.expired.map(row => row.code));
      return codes.filter(code => !expired.has(code));
    };
    if (!codes.length || !missingCodes(read()).length) return;
    withFileLock(file, () => {
      const state = read(), additions = missingCodes(state);
      if (!additions.length) return;
      state.expired.push(...additions.map(code => ({ code, reason, at: new Date(now()).toISOString() })));
      atomicJson(file, state);
    });
  }
  const readPublic = () => {
    const data = readJson(catalogFile, { version: 1, codes: [], expired: [] });
    if (data?.version !== 1 || !Array.isArray(data.codes) || !Array.isArray(data.expired)
      || [...data.codes, ...data.expired].some(row => !row || typeof row.code !== 'string')) throw Error('公共礼包码数据库无效');
    data.channels ??= [];
    data.wiki ??= { enabled: true, codes: [] };
    if (typeof data.wiki.enabled !== 'boolean' || !Array.isArray(data.wiki.codes)) throw Error('Wiki 礼包码缓存无效');
    if (!Array.isArray(data.channels) || data.channels.some(row => !row || typeof row.id !== 'string'
      || !Array.isArray(row.codes) || typeof row.enabled !== 'boolean')) throw Error('礼包码渠道数据无效');
    // Older catalogs stored only the sync state for the two preconfigured channels.
    return upgradeGiftRule({ id: 'ali213', name: '游侠网', url: GIFT_CODE_SOURCE, enabled: true, ...(data.mode ? {} : articleRule), ...data,
      wiki: upgradeGiftRule({ id: 'game-wiki', name: '疯狂水世界 Wiki', url: GIFT_CODE_WIKI, ...(data.wiki.mode ? {} : wikiRule), ...data.wiki }),
      channels: data.channels.map(upgradeGiftRule) });
  };
  const preferences = () => {
    const data = readJson(preferenceFile, { version: 1, accounts: [] });
    if (data?.version !== 1 || !Array.isArray(data.accounts)
      || data.accounts.some(account => !account || typeof account.id !== 'string' || typeof account.enabled !== 'boolean')) throw Error('自动兑换设置无效');
    return data;
  };
  const changePreference = (id, work) => withFileLock(preferenceFile, () => {
    const data = preferences();
    let account = data.accounts.find(entry => entry.id === id);
    if (!account) { account = { id, enabled: false }; data.accounts.push(account); }
    work(account); atomicJson(preferenceFile, data); return { ...account };
  });
  const sourceList = data => [data.wiki, data, ...data.channels];
  const sourceState = (data, id) => id === 'ali213' ? data : id === 'game-wiki' ? data.wiki : data.channels.find(source => source.id === id);
  const currentSource = () => {
    const data = readPublic(), enabled = sourceList(data).filter(channel => channel.enabled);
    const useBundle = data.enabled && !data.lastSuccessAt && data.url === GIFT_CODE_SOURCE && data.mode === articleRule.mode && data.pattern === articleRule.pattern;
    const base = useBundle ? catalog(now()) : data.enabled && data.lastSuccessAt
      ? { source: data.url, updatedAt: data.sourceUpdatedAt, codes: data.codes } : { source: null, codes: [] };
    const codes = [...base.codes], known = new Map();
    for (const [index, row] of codes.entries()) if (!known.has(row.code)) known.set(row.code, index);
    for (const channel of [data.wiki, ...data.channels]) {
      if (!channel.enabled) continue;
      for (const row of channel.codes) {
        const index = known.get(row.code);
        if (index === undefined) {
          known.set(row.code, codes.length);
          codes.push(row);
        } else if (row.expiresAt && (!codes[index].expiresAt || row.expiresAt < codes[index].expiresAt)) {
          codes[index] = { ...codes[index], expiresAt: row.expiresAt };
        }
      }
    }
    const times = enabled.map(channel => channel.lastSuccessAt).filter(Boolean).sort();
    const source = !times.length && base.source ? base.source : enabled.length === 1 ? enabled[0].url : null;
    return { ...base, source, codes, retired: data.expired,
      sourceKind: times.length ? 'synced' : useBundle ? 'bundled' : 'custom',
      lastSyncedAt: times.at(-1) ?? null,
      lastError: enabled.filter(channel => channel.lastError).map(channel => channel.name + '：' + channel.lastError).join('；') };
  };
  const updateSources = work => withFileLock(catalogFile, () => {
    const data = readPublic();
    const result = work(data);
    if (result !== false) atomicJson(catalogFile, data);
    return result;
  });
  const parseChannel = async channel => {
    const originalUrl = channel.url === GIFT_CODE_SOURCE || channel.url === GIFT_CODE_WIKI;
    const body = await fetchChannelBody(channel.url, fetcher ?? (originalUrl ? fetch : undefined));
    return parseChannelBody(channel, body, now());
  };
  const dueToday = source => !source.lastSuccessAt || giftDay(Date.parse(source.lastSuccessAt)) !== giftDay(now());
  function syncChannel(id, force) {
    if (fetching.has(id)) return fetching.get(id);
    const token = randomUUID();
    const channel = updateSources(data => {
      const state = sourceState(data, id);
      if (!state || state.enabled === false || !dueToday(state) || state.leaseUntil > now()
        || state.lastAttemptAt && now() - state.lastAttemptAt < (force ? 60000 : 3600000)) return false;
      Object.assign(state, { token, lastAttemptAt: now(), leaseUntil: now() + 90000 });
      return sourceList(data).find(item => item.id === id);
    });
    if (!channel) return;
    // A rule edit, disable, deletion or expired lease can supersede this request.
    const finish = apply => updateSources(data => {
      const state = sourceState(data, id);
      if (!state || state.token !== token) return false;
      delete state.token;
      state.leaseUntil = 0;
      apply(state, data);
    });
    const job = (async () => {
      try {
        const parsed = await parseChannel(channel);
        finish((state, data) => {
          const at = new Date(now()).toISOString();
          const retired = new Set([...data.expired, ...read().expired].map(row => row.code));
          const keepPrevious = id === 'ali213' && channel.mode === articleRule.mode && channel.pattern === articleRule.pattern;
          const codes = new Map(keepPrevious ? state.codes.map(row => [row.code, row]) : []);
          for (const row of parsed.rows) {
            if (retired.has(row.code)) continue;
            if (expiredDate(row.expiresAt, now())) {
              codes.delete(row.code);
              data.expired.push({ code: row.code, reason: '来源注明的有效期已结束', at });
              retired.add(row.code);
            } else {
              codes.set(row.code, { ...row, firstSeenAt: codes.get(row.code)?.firstSeenAt ?? at, lastSeenAt: at });
            }
          }
          Object.assign(state, { codes: [...codes.values()], sourceUpdatedAt: parsed.sourceUpdatedAt ?? null, lastSuccessAt: at, lastError: '' });
        });
      } catch (error) {
        if (finish(state => { state.lastError = error.message; }) !== false) throw Error(channel.name + '：' + error.message);
      }
    })().finally(() => { if (fetching.get(id) === job) fetching.delete(id); });
    fetching.set(id, job);
    return job;
  }
  const merge = (state, source) => {
    const rows = new Map();
    for (const row of source.codes) if (!rows.has(row.code)) rows.set(row.code, { ...row, manual: false });
    for (const row of state.codes) {
      const original = rows.get(row.code);
      rows.set(row.code, original ? { ...original, ...row, manual: true,
        expiresAt: original.expiresAt && (!row.expiresAt || original.expiresAt < row.expiresAt) ? original.expiresAt : row.expiresAt }
        : { ...row, manual: true });
    }
    const expired = new Set([...state.expired, ...(source.retired ?? [])].map(row => row.code));
    return [...rows.values()].map(row => ({ ...row, expired: expired.has(row.code) || expiredDate(row.expiresAt, now()) }));
  };
  const library = {
    channels() {
      return sourceList(readPublic()).map(({ id, name, url, enabled, pattern, mode, jsonField, lastSuccessAt, lastError }) =>
        ({ id, name, url, enabled, pattern, mode, jsonField, builtin: isDefaultChannel(id), lastSuccessAt, lastError }));
    },
    saveChannel(input) {
      const config = channelConfig(input);
      return updateSources(data => {
        const id = input.id ?? randomUUID();
        const existing = sourceState(data, id);
        if (input.id != null && !existing) throw Error('渠道已删除，请刷新列表');
        if (existing) {
          if (['url', 'mode', 'pattern', 'jsonField'].some(key => existing[key] !== config[key])) {
            Object.assign(existing, { codes: [], token: null, leaseUntil: 0, lastAttemptAt: 0, lastSuccessAt: null, sourceUpdatedAt: null, lastError: '' });
            fetching.delete(id);
          }
          Object.assign(existing, config);
        } else {
          if (data.channels.length >= 16) throw Error('最多可添加 16 个自定义渠道');
          data.channels.push({ id, ...config, enabled: true, codes: [] });
        }
        return { id };
      });
    },
    previewChannel: async input => (await parseChannel(channelConfig(input))).rows.map(row => row.code),
    setChannelEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw Error('渠道开关无效');
      updateSources(data => {
        const source = sourceState(data, id);
        if (!source) throw Error('渠道不存在');
        if ((source.enabled !== false) === enabled) return false;
        Object.assign(source, { enabled, token: null, leaseUntil: 0, lastAttemptAt: 0 });
        fetching.delete(id);
      });
    },
    removeChannel(id) {
      updateSources(data => {
        if (isDefaultChannel(id) || !sourceState(data, id)) throw Error('请选择已有的自定义渠道');
        data.channels = data.channels.filter(row => row.id !== id);
        fetching.delete(id);
      });
    },
    entries() { return merge(read(), currentSource()).filter(row => !row.expired); },
    available(rows) {
      const handled = new Set(rows.filter(hasGiftCodeHistory).map(row => row.code));
      return library.entries().filter(row => !handled.has(row.code)).map(row => row.code);
    },
    view() {
      const source = currentSource(), state = read(), merged = merge(state, source), usable = merged.filter(row => !row.expired);
      const byCode = new Map(merged.map(row => [row.code, row])), publicCodes = new Set(source.codes.map(row => row.code));
      // Retain the original catalog rows (including duplicates/expired entries)
      // for API compatibility; entries() is the deduplicated usable library.
      const codes = [...source.codes.map(row => ({ ...row, ...byCode.get(row.code) })), ...merged.filter(row => !publicCodes.has(row.code))];
      const additionalExpired = new Set([...state.expired, ...source.retired].filter(row => !byCode.has(row.code)).map(row => row.code));
      return { source: source.source, sourceKind: source.sourceKind, updatedAt: source.updatedAt,
        lastSyncedAt: source.lastSyncedAt, lastError: source.lastError, dailyTime: '每天北京时间 08:00',
        total: codes.length, unique: merged.length, expired: codes.filter(row => row.expired).length + additionalExpired.size, codes, tryCodes: usable.map(row => row.code),
        batches: Array.from({ length: Math.ceil(usable.length / 100) }, (_, index) => usable.slice(index * 100, (index + 1) * 100).map(row => row.code)),
        revision: createHash('sha256').update(JSON.stringify(usable.map(row => [row.code, row.expiresAt]))).digest('hex') };
    },
    isExpired(code) {
      const state = read(), source = currentSource();
      if ([...state.expired, ...source.retired].some(row => row.code === code)) return true;
      return merge(state, source).some(row => row.code === code && row.expired);
    },
    expire(code, reason) {
      recordExpired([code], reason);
    },
    reconcile(rows) {
      const codes = [...new Set(rows.filter(row => row.status === 'rejected'
        && (row.promptName === 'GIFT_CODE_EXPIRED' || row.detail === '礼包码已过期')).map(row => row.code))];
      recordExpired(codes);
    },
    addManualBatch(input, expiry) {
      if (!Array.isArray(input) || !input.length || input.length > 500) throw Error('单次请提供 1 至 500 条礼包码');
      if (input.some(code => typeof code !== 'string' || code.trim().length > 128 || !codePattern.test(code.trim()))) {
        throw Error('礼包码需为1至128个汉字、字母、数字、下划线或短横线');
      }
      const codes = [...new Set(input.map(code => code.trim()))];
      const expiresAt = normalizeExpiry(expiry, now());
      return withFileLock(file, () => {
        const state = read(), source = currentSource();
        const expired = new Set([...state.expired, ...source.retired, ...source.codes.filter(row => expiredDate(row.expiresAt, now()))].map(row => row.code));
        if (codes.some(code => expired.has(code))) throw Error('批次包含已过期或全局下架的礼包码，未保存任何条目');
        const entries = new Map(state.codes.map(row => [row.code, row]));
        for (const code of codes) entries.set(code, { code, expiresAt, firstSeenAt: entries.get(code)?.firstSeenAt ?? new Date(now()).toISOString() });
        atomicJson(file, { ...state, codes: [...entries.values()] });
        return { saved: codes.length, codes: codes.length };
      });
    },
    pruneExpired() {
      if (!readPublic().codes.some(row => expiredDate(row.expiresAt, now()))) return;
      withFileLock(catalogFile, () => {
        const data = readPublic(), expired = new Set(data.expired.map(row => row.code));
        data.codes = data.codes.filter(row => {
          if (!expiredDate(row.expiresAt, now())) return true;
          if (!expired.has(row.code)) { data.expired.push({ code: row.code, reason: '来源注明的有效期已结束', at: new Date(now()).toISOString() }); expired.add(row.code); }
          return false;
        });
        atomicJson(catalogFile, data);
      });
    },
    auto(id) { return { enabled: false, ...preferences().accounts.find(entry => entry.id === id) }; },
    setAuto(id, enabled) {
      if (typeof enabled !== 'boolean') throw Error('自动兑换开关必须为布尔值');
      return changePreference(id, account => {
        if (account.enabled !== enabled) { account.lastRunKey = ''; account.lastAttemptAt = 0; }
        account.enabled = enabled;
      });
    },
    accountRevision() { return createHash('sha256').update(JSON.stringify(library.entries().map(row => [row.code, row.expiresAt]))).digest('hex'); },
    attempt(id, key) { return changePreference(id, account => { account.lastRunKey = key; account.lastAttemptAt = now(); }); },
    retry(id, key) { return changePreference(id, account => { if (account.lastRunKey === key) account.lastRunKey = ''; }); },
    removeAccount(id) {
      if (!preferences().accounts.some(account => account.id === id)) return;
      withFileLock(preferenceFile, () => { const data = preferences(); data.accounts = data.accounts.filter(account => account.id !== id); atomicJson(preferenceFile, data); });
    },
    due() {
      const time = now();
      return new Date(time + 8 * 3600000).getUTCHours() >= 8
        && sourceList(readPublic()).some(channel => channel.enabled && dueToday(channel));
    },
    async refresh({ force = false } = {}) {
      const pending = sourceList(readPublic()).filter(channel => channel.enabled && dueToday(channel));
      const errors = [];
      for (let i = 0; i < pending.length; i += 4) {
        const result = await Promise.allSettled(pending.slice(i, i + 4).map(channel => syncChannel(channel.id, force)));
        for (const item of result) if (item.status === 'rejected') errors.push(item.reason.message);
      }
      if (errors.length) throw Error(errors.join(' / '));
      return library.view();
    },
  };
  return library;
}

export const publicGiftCodes = createGiftCodeLibrary();
