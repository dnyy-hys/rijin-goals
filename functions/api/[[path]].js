import { handleApi } from '../../src/cloudflare-api.js';

export async function onRequest(context) {
  return handleApi(context.request, context.env);
}
