import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestContext } from '../request-context.js';
import { validPushSubscription } from '../push-subscription.js';

const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers: { host: 'localhost:4173', ...headers } });

test('direct traffic cannot spoof HTTPS, host, or rate-limit identity', () => {
  const context = createRequestContext();
  const req = request({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '198.51.100.4', origin: 'https://evil.example' });
  assert.equal(context.secureRequest(req), false);
  assert.equal(context.verifyOrigin(req), false);
  assert.equal(context.clientIp(req), '127.0.0.1');
});

test('loopback proxy supports HTTPS and distinct visitors', () => {
  const context = createRequestContext({ trustProxy: 'loopback' });
  const req = request({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'goals.example.com', origin: 'https://goals.example.com', 'x-forwarded-for': '203.0.113.8' }, '::ffff:127.0.0.1');
  assert.equal(context.secureRequest(req), true);
  assert.equal(context.verifyOrigin(req), true);
  assert.equal(context.clientIp(req), '203.0.113.8');
  req.socket.remoteAddress = '198.51.100.3';
  assert.equal(context.secureRequest(req), false);
  assert.equal(context.verifyOrigin(req), false);
  assert.equal(context.clientIp(req), '198.51.100.3');
});

test('production origin cannot be changed by forwarded host headers', () => {
  const context = createRequestContext({ publicOrigin: 'https://goals.example.com', trustProxy: '1' });
  assert.equal(context.verifyOrigin(request({ origin: 'https://goals.example.com' })), true);
  assert.equal(context.verifyOrigin(request({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })), false);
  assert.equal(context.secureRequest(request()), true);
});

test('invalid proxy addresses cannot create arbitrary limiter identities', () => {
  const context = createRequestContext({ trustProxy: '1' });
  assert.equal(context.clientIp(request({ 'x-forwarded-for': 'not-an-ip' })), '127.0.0.1');
  assert.equal(context.clientIp(request({ 'x-forwarded-for': 'spoofed, 203.0.113.9' })), '203.0.113.9');
});

test('deployment configuration rejects insecure origins and invalid trust settings', () => {
  for (const publicOrigin of ['http://goals.example.com', 'https://goals.example.com/path', 'https://user:pass@goals.example.com', 'https://goals.example.com?q=1']) {
    assert.throws(() => createRequestContext({ publicOrigin }));
  }
  assert.throws(() => createRequestContext({ trustProxy: 'yes' }));
});

test('push endpoints accept browser providers and reject internal or lookalike hosts', () => {
  const keys = { auth: Buffer.alloc(16).toString('base64url'), p256dh: Buffer.alloc(65).toString('base64url') };
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/id', 'https://updates.push.services.mozilla.com/wpush/v2/id', 'https://web.push.apple.com/id', 'https://wns2.notify.windows.com/id']) {
    assert.equal(validPushSubscription({ endpoint, keys }), true, endpoint);
  }
  for (const endpoint of ['https://127.0.0.1/private', 'https://169.254.169.254/', 'https://fcm.googleapis.com.evil.example/id', 'http://fcm.googleapis.com/id', 'https://fcm.googleapis.com:8443/id', 'https://user:pass@fcm.googleapis.com/id']) {
    assert.equal(validPushSubscription({ endpoint, keys }), false, endpoint);
  }
  assert.equal(validPushSubscription({ endpoint: 'https://fcm.googleapis.com/id', keys: { auth: 'bad', p256dh: 'bad' } }), false);
});
