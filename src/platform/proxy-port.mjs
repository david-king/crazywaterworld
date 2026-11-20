import { createServer } from 'node:net';

export const DEFAULT_PROXY_PORT = Number(process.env.CW_PROXY_PORT ?? 17322);

export function validateProxyPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须是 1–65535 的整数');
}

// Probe only the configured loopback socket, before changing Windows trust or proxy settings.
export function checkProxyPort(port) {
  validateProxyPort(port);
  const probe = createServer(socket => socket.destroy());
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(error => error ? reject(error) : resolve());
    });
  });
}

export function proxyPortFailure(port, code) {
  if (code === 'EADDRINUSE') return `本机采集端口 ${port} 已被占用。请检查占用程序，并确认控制台端口 CW_PORT 和采集端口 CW_PROXY_PORT 分开设置。`;
  if (code === 'EACCES') return `系统拒绝监听本机采集端口 ${port}。请检查该端口是否已被系统保留或被其他程序独占。`;
  return null;
}
