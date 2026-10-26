/**
 * Prompt Builder server — zero dependencies, Node 18+.
 *
 *   GET  /api/roles    → data/roles.json
 *   GET  /api/options  → data/options.json
 *   POST /api/prompt   → { prompt, score, tips, tokens } built from a state object
 *   GET  /api/ai/status → { configured, model }
 *   POST /api/ai/refine → { improved_prompt, changes, questions, usage }  (uses API tokens)
 *   POST /api/ai/test   → Server-Sent Events stream of the model's answer (uses API tokens)
 *   GET  /*            → static files from /public
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load .env (Node 20.12+); a missing file just means AI stays disabled.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env */ }

const PromptBuilder = require('./public/js/prompt-builder');
const ai = require('./lib/ai');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Read data fresh on each request so JSON edits show up without a restart.
const readData = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && pathname === '/api/roles') return sendJson(res, 200, readData('roles.json'));
    if (req.method === 'GET' && pathname === '/api/options') return sendJson(res, 200, readData('options.json'));

    if (req.method === 'POST' && pathname === '/api/prompt') {
      const state = JSON.parse((await readBody(req)) || '{}');
      const data = { roles: readData('roles.json').roles, options: readData('options.json') };
      const prompt = PromptBuilder.build(state, data);
      return sendJson(res, 200, { prompt, tokens: PromptBuilder.estimateTokens(prompt), ...PromptBuilder.analyze(state, data) });
    }

    if (req.method === 'GET' && pathname === '/api/ai/status') {
      return sendJson(res, 200, { configured: ai.isConfigured(), model: ai.MODEL });
    }
    if (req.method === 'POST' && (pathname === '/api/ai/refine' || pathname === '/api/ai/test')) {
      const { prompt } = JSON.parse((await readBody(req)) || '{}');
      if (typeof prompt !== 'string' || !prompt.trim()) return sendJson(res, 400, { error: 'prompt is required' });
      if (pathname === '/api/ai/refine') return sendJson(res, 200, await ai.refine(prompt));
      return await ai.test(prompt, req, res);
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (res.headersSent) return res.end();
    sendJson(res, err instanceof SyntaxError ? 400 : err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Prompt Builder running at http://localhost:${PORT}`));
