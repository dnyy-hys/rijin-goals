// Public registration must not turn arbitrary subscription URLs into server-side requests.
export function validPushSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string') return false;
  let url;
  try { url = new URL(subscription.endpoint); } catch { return false; }
  const host = url.hostname;
  const supportedHost = ['fcm.googleapis.com', 'android.googleapis.com', 'web.push.apple.com'].includes(host)
    || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com');
  if (!supportedHost || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return false;
  const validKey = (value, length) => typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) && Buffer.from(value, 'base64url').length === length;
  return validKey(subscription.keys?.auth, 16) && validKey(subscription.keys?.p256dh, 65);
}
