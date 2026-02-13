const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const { Readable } = require('stream');

const app = express();

// Railway sets PORT. Default to 3000 for local dev.
const PORT = Number(process.env.PORT || 3000);

// ---- Middleware ----
app.disable('x-powered-by');

// Helmet is great, but the default CSP will block CDN scripts.
// We disable CSP here to keep this template simple.
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(compression());

// Perplexity supports large base64 payloads (images/files).
// Adjust this based on your needs.
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// ---- Static UI ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Health ----
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

function getApiKey(req) {
  // Prefer a custom header so it doesn't get accidentally logged in request bodies.
  // The frontend stores it in localStorage and sends it per-request.
  const key = req.header('x-pplx-key') || req.header('x-perplexity-key');
  return key ? String(key).trim() : '';
}

function safeCopyHeaders(fromHeaders) {
  const out = {};
  const allow = [
    'content-type',
    'cache-control',
    'x-request-id',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
  ];
  for (const h of allow) {
    const v = fromHeaders.get(h);
    if (v) out[h] = v;
  }
  return out;
}

async function proxyPerplexity(req, res, { url, method, body }) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing API key. Send it in the x-pplx-key header.' });
  }

  const upstream = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Forward status + selected headers
  res.status(upstream.status);
  res.set(safeCopyHeaders(upstream.headers));

  // If there is no body, end.
  if (!upstream.body) {
    const text = await upstream.text().catch(() => '');
    return res.send(text);
  }

  // Stream through without buffering.
  // Node fetch returns a WHATWG ReadableStream; Express wants a Node stream.
  try {
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    // Fallback: buffer
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  }
}

// ---- Chat Completions Proxy ----
// POST /api/chat
// Body = the Perplexity /chat/completions request body (model, messages, etc.)
app.post('/api/chat', async (req, res) => {
  try {
    await proxyPerplexity(req, res, {
      url: 'https://api.perplexity.ai/chat/completions',
      method: 'POST',
      body: req.body,
    });
  } catch (err) {
    console.error('Proxy error (/api/chat):', err?.message || err);
    res.status(500).json({ error: 'Server proxy error.' });
  }
});

// ---- Deep Research Async API ----
// POST /api/async/submit  (body shape: { request: {...chat completion body...} })
app.post('/api/async/submit', async (req, res) => {
  try {
    await proxyPerplexity(req, res, {
      url: 'https://api.perplexity.ai/async/chat/completions',
      method: 'POST',
      body: req.body,
    });
  } catch (err) {
    console.error('Proxy error (/api/async/submit):', err?.message || err);
    res.status(500).json({ error: 'Server proxy error.' });
  }
});

// GET /api/async/get/:id
app.get('/api/async/get/:id', async (req, res) => {
  try {
    const apiKey = getApiKey(req);
    if (!apiKey) {
      return res.status(400).json({ error: 'Missing API key. Send it in the x-pplx-key header.' });
    }

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing async request id.' });

    const upstream = await fetch(`https://api.perplexity.ai/async/chat/completions/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    res.status(upstream.status);
    res.set(safeCopyHeaders(upstream.headers));

    const text = await upstream.text();
    // Response is JSON. Send as-is.
    res.type('application/json').send(text);
  } catch (err) {
    console.error('Proxy error (/api/async/get):', err?.message || err);
    res.status(500).json({ error: 'Server proxy error.' });
  }
});

// SPA fallback: serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
