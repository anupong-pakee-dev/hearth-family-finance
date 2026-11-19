/**
 * Security headers (NFR-SEC-13, 19–21). Target: Mozilla Observatory A+ / securityheaders.com A+.
 */
import { config } from '../config.ts';

export function securityHeaders(nonce: string): Record<string, string> {
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "require-trusted-types-for 'script'",
    // "default" is created only by slip.js and only lets the same-origin OCR worker through (FR-TXN-06)
    'trusted-types hearth default',
    ...(config.secureCookies ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  const h: Record<string, string> = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    // same-origin: never leaks anything cross-site (stricter than strict-origin-when-cross-origin),
    // while letting the app return users to the form they came from.
    'referrer-policy': 'same-origin',
    'permissions-policy': 'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(self), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=(), browsing-topics=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'x-frame-options': 'DENY',
    'origin-agent-cluster': '?1',
    'x-permitted-cross-domain-policies': 'none',
  };
  if (config.secureCookies) h['strict-transport-security'] = 'max-age=63072000; includeSubDomains; preload';
  return h;
}
