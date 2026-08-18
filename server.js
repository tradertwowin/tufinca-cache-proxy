import express from 'express';
import { Readable } from 'node:stream';

const app = express();
app.use(express.json({ limit: '10mb' }));

const DEBUG_LOG_TOOLS = process.env.DEBUG_LOG_TOOLS === 'true';

function hashTools(tools) {
  const str = JSON.stringify(tools);
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  return { hash, length: str.length };
}

app.post('/v1/messages', async (req, res) => {
  const originalBody = req.body;
  let body = originalBody;

  try {
    body = JSON.parse(JSON.stringify(originalBody)); // clona, no muta el original

    if (DEBUG_LOG_TOOLS && Array.isArray(body.tools)) {
      console.log('[tools-check]', JSON.stringify(hashTools(body.tools)));
    }

   if (typeof body.system === 'string' && body.system.length > 0) {
      body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    } else if (Array.isArray(body.system) && body.system.length > 0) {
      body.system[body.system.length - 1].cache_control = { type: 'ephemeral', ttl: '1h' };
    }
  } catch (mutationError) {
    console.error('[proxy] fallo preparando cache_control, reenviando sin cachear:', mutationError);
    body = originalBody;
  }

 const forwardHeaders = { 'content-type': 'application/json' };
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase().startsWith('anthropic-') || key.toLowerCase() === 'x-api-key') {
      forwardHeaders[key] = value;
    }
  }
  forwardHeaders['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    res.status(upstream.status);
    const skipHeaders = ['content-encoding', 'content-length', 'transfer-encoding'];
    upstream.headers.forEach((v, k) => { if (!skipHeaders.includes(k.toLowerCase())) res.setHeader(k, v); });
    const responseBuffer = Buffer.from(await upstream.arrayBuffer());
    res.send(responseBuffer);
  } catch (fetchError) {
    console.error('[proxy] fallo llamando a Anthropic:', fetchError.message);
    res.status(fetchError.name === 'AbortError' ? 504 : 502).json({
      error: { type: 'proxy_error', message: 'No se pudo contactar a Anthropic: ' + fetchError.message },
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8080, () => console.log('cache-proxy listo en :' + (process.env.PORT || 8080)));
