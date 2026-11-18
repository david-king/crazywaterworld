// Research only. Raw payloads stay in bounded memory; the per-run HMAC key is never exported.
import { createHmac, randomBytes } from 'node:crypto';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';

export const SAMPLE_LIMIT = 1024 * 1024;
export function createMetadataSampler({ emit = () => {}, limit = SAMPLE_LIMIT } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > SAMPLE_LIMIT) throw new Error('BAD_SAMPLE_LIMIT');
  const key = randomBytes(32);
  const digest = value => createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 24);
  const name = value => /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(String(value)) ? String(value) : `hmac:${digest(value)}`;
  const safeEmit = value => { try { emit(value); } catch {} };
  function describeUrl(raw) {
    try {
      const url = new URL(raw, 'https://minigame.zijieapi.com');
      return {
        path: url.pathname.split('/').map(part => !part ? '' : /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(part) ? part : `[hmac:${digest(part)}]`).join('/'),
        queryKeys: [...new Set([...url.searchParams.keys()].map(name))].slice(0, 100),
      };
    } catch { return { path: '[invalid]', queryKeys: [] }; }
  }
  function begin({ id, direction, host, url, method, status, headers = {} }) {
    const base = { at: new Date().toISOString(), id, direction, host, ...describeUrl(url), method: /^[A-Z]{1,16}$/.test(method) ? method : '[other]',
      ...(Number.isInteger(status) ? { status } : {}), headerNames: Object.keys(headers).map(name).sort().slice(0, 100) };
    let chunks = [], bytes = 0, overflow = false, ended = false;
    const encoding = String(headers['content-encoding'] || '').toLowerCase().trim();
    const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return {
      add(chunk) {
        if (ended || overflow) return;
        try {
          bytes += chunk.length;
          if (bytes > limit) { overflow = true; chunks = []; return; }
          chunks.push(Buffer.from(chunk));
        } catch { overflow = true; chunks = []; }
      },
      end() {
        if (ended) return;
        ended = true;
        try {
          if (overflow) { safeEmit({ ...base, sample: 'compressed_limit', fields: [] }); return; }
          let body = Buffer.concat(chunks); chunks = [];
          if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: limit });
          else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: limit });
          else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: limit });
          else if (encoding && encoding !== 'identity') { safeEmit({ ...base, sample: 'unsupported_encoding', fields: [] }); return; }
          if (body.length > limit) { safeEmit({ ...base, sample: 'decompressed_limit', fields: [] }); return; }
          if (!body.length) { safeEmit({ ...base, sample: 'empty', fields: [] }); return; }
          let value;
          if (contentType === 'application/x-www-form-urlencoded') {
            value = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
          } else {
            // Parsing is local only. Neither raw text nor parsing exception messages are emitted.
            value = JSON.parse(body.toString('utf8'));
          }
          const fields = [], credentialFields = []; let truncated = false;
          function walk(item, path, depth) {
            if (fields.length >= 256 || depth > 12) { truncated = true; return; }
            const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
            if (type === 'object' || type === 'array') {
              fields.push({ path, type });
              const entries = Object.entries(item);
              for (const [k, v] of entries.slice(0, 64)) {
                const fieldPath = type === 'array' ? `${path}[${k}]` : `${path}.${name(k)}`;
                if (credentialFields.length < 256 && /^(code|anonymous_?code|session(?:_?key|_?id)?|token|access_?token)$/i.test(k) && v != null) credentialFields.push(fieldPath);
                walk(v, fieldPath, depth + 1);
              }
              if (entries.length > 64) truncated = true;
            } else fields.push({ path, type,
              ...(type === 'string' ? { length: item.length } : {}),
              ...((type === 'boolean' || type === 'number') && /\.(?:isLogin|is_login|error_code|errorCode|errcode|err_no|status|success|code)$/.test(path) ? { value: item } : {}),
              ...(item === null ? {} : { hmac: digest(item) }) });
          }
          walk(value, '$', 0);
          safeEmit({ ...base, sample: 'parsed', fields, credentialFields, truncated });
        } catch { safeEmit({ ...base, sample: 'unparsed_or_decode_limit', fields: [] }); }
        finally { chunks = []; }
      },
      abort() { if (!ended) { ended = true; chunks = []; safeEmit({ ...base, sample: 'incomplete', fields: [] }); } },
    };
  }
  return { begin };
}
