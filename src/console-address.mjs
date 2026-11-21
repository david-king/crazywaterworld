import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export function normalizeConsoleHost(value) {
  let host = String(value ?? '').trim() || '127.0.0.1';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host.includes('%') && isIP(host)) return host;
  if (host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return host;
  throw new Error('--host 或 CW_HOST 请填写 IP 地址或主机名，不要包含 http://、端口或路径');
}

export function isConsoleHostOption(arg) {
  return arg === '--host' || arg?.startsWith('--host=');
}

export function consoleHost(env = process.env, args = []) {
  const index = args.findLastIndex(isConsoleHostOption);
  if (index < 0) return normalizeConsoleHost(env.CW_HOST);
  const option = args[index];
  const next = args[index + 1];
  if (option === '--host' && (next === undefined || next.startsWith('--'))) return '0.0.0.0';
  const host = option === '--host' ? next : option.slice('--host='.length);
  if (!host.trim()) throw new Error('--host 的地址不能为空，可单独使用 --host 监听所有 IPv4 网卡');
  return normalizeConsoleHost(host);
}

// Wildcard addresses describe where to listen, not where a browser should go.
// Other devices use this computer's LAN address; this URL is for local access.
export function consoleUrl(host, port) {
  const normalized = normalizeConsoleHost(host);
  const value = Number(port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('控制台端口无效');
  if (normalized === '0.0.0.0') return `http://127.0.0.1:${value}`;
  if (isIP(normalized) === 6) {
    const ipv6 = new URL(`http://[${normalized}]/`).hostname;
    return `http://${ipv6 === '[::]' ? '[::1]' : ipv6}:${value}`;
  }
  return `http://${normalized}:${value}`;
}

function isLanAddress(address) {
  if (isIP(address) === 6) return /^f[cd][0-9a-f]{2}:/i.test(address) && !address.includes('%');
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 169 && second === 254);
}

// Use the bound socket's address at startup so hostnames and port 0 are resolved.
export function consoleAccessHints(host, port, interfaces = networkInterfaces) {
  const name = normalizeConsoleHost(host);
  const ip = isIP(name) === 6 ? new URL(`http://[${name}]`).hostname.slice(1, -1) : name;
  if ((isIP(ip) === 4 && ip.startsWith('127.')) || ip === '::1' || ip.toLowerCase() === 'localhost') {
    return ['监听范围  仅本机可直接访问'];
  }
  if (ip !== '0.0.0.0' && ip !== '::') {
    return [`${isLanAddress(ip) ? '局域网地址' : '监听地址'}  ${consoleUrl(ip, port)}/`];
  }
  const family = ip === '::' ? 6 : 4;
  const urls = new Map();
  try {
    for (const [adapter, entries] of Object.entries(interfaces())) {
      for (const entry of entries ?? []) {
        if (!entry || entry.internal || isIP(entry.address) !== family || !isLanAddress(entry.address)) continue;
        const url = consoleUrl(entry.address, port) + '/';
        if (!urls.has(url)) urls.set(url, adapter);
      }
    }
  } catch { /* Interface enumeration can be unavailable on a restricted host. */ }
  return urls.size ? Array.from(urls, ([url, adapter]) => `局域网地址（${adapter}）  ${url}`)
    : [`未找到可列出的 IPv${family} 局域网地址，请检查电脑的网络连接。`];
}
