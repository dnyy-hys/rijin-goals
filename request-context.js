import { isIP } from 'node:net';

// Forwarded headers only have authority when the immediate proxy is trusted.
export function createRequestContext({ publicOrigin = '', trustProxy = 'none' } = {}) {
  if (!['none', 'loopback', '1'].includes(trustProxy)) throw new Error('TRUST_PROXY must be none, loopback, or 1');
  const canonical = publicOrigin ? new URL(publicOrigin) : null;
  if (canonical && (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.pathname !== '/' || canonical.search || canonical.hash)) {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  const normalize = (ip = '') => ip.replace(/^::ffff:/, '');
  const trusted = (req) => trustProxy === '1' || (trustProxy === 'loopback' && ['127.0.0.1', '::1'].includes(normalize(req.socket.remoteAddress)));
  const protocol = (req) => req.socket.encrypted || (trusted(req) && req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http';
  return {
    secureRequest(req) { return canonical?.protocol === 'https:' || protocol(req) === 'https'; },
    verifyOrigin(req) {
      if (!req.headers.origin) return true;
      const host = trusted(req) ? req.headers['x-forwarded-host'] || req.headers.host : req.headers.host;
      return req.headers.origin === (canonical?.origin || `${protocol(req)}://${host}`);
    },
    clientIp(req) {
      if (trusted(req)) {
        // The deployment's Caddy proxy overwrites this with the direct visitor IP.
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
        if (isIP(forwarded)) return normalize(forwarded);
      }
      return normalize(req.socket.remoteAddress) || 'unknown';
    },
  };
}
