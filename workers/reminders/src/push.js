import { buildPushPayload } from '@block65/webcrypto-web-push';

export async function sendPush(subscription, payload, env) {
  const message = { data: JSON.stringify(payload), options: { ttl: 1800, urgency: 'normal', topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } };
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const response = await fetch(subscription.endpoint, { ...await buildPushPayload(message, subscription, vapid), signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error(`Push service returned HTTP ${response.status}`), { status: response.status });
  return response.status;
}
