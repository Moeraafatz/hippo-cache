import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HippoCacheEngine } from '../core/engine.js';
import { seedDemoMemories } from '../core/demo.js';
import { handleMcpRequest } from '../mcp/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../../web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(body);
}

export function createHttpServer({
  dbPath = '.hippo-cache/memory.db',
  namespace = 'default',
  engine: providedEngine = null
} = {}) {
  const engine = providedEngine || new HippoCacheEngine(dbPath);
  const sseClients = new Set();

  const unsubscribe = engine.subscribe((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  const handler = async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
      });
      return res.end();
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const ns = url.searchParams.get('ns') || namespace;

    try {
      // --- Health ---
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', engine: 'hippo-cache', version: '1.0.0', dbPath });
      }

      // --- SSE live stream ---
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', namespace: ns })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // --- Streamable HTTP JSON-RPC MCP endpoint ---
      if (pathname === '/mcp' && req.method === 'POST') {
        const body = await readBody(req);
        const reply = handleMcpRequest(engine, body, ns);
        if (!reply) {
          res.writeHead(202);
          return res.end();
        }
        return sendJson(res, 200, reply);
      }

      // --- REST API ---
      if (pathname === '/api/stats' && req.method === 'GET') {
        return sendJson(res, 200, engine.getStats(ns));
      }

      if (pathname === '/api/graph' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 80);
        return sendJson(res, 200, engine.getGraph(ns, { limit }));
      }

      if (pathname === '/api/timeline' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 40);
        return sendJson(res, 200, engine.getTimeline(ns, limit));
      }

      if (pathname === '/api/memories' && req.method === 'GET') {
        const status = url.searchParams.get('status') || 'all';
        const kind = url.searchParams.get('kind') || 'all';
        const limit = Number(url.searchParams.get('limit') || 100);
        return sendJson(res, 200, { namespace: ns, memories: engine.listMemories(ns, { status, kind, limit }) });
      }

      if (pathname === '/api/remember' && req.method === 'POST') {
        const body = await readBody(req);
        const result = engine.remember({
          namespace: body.namespace || ns,
          content: body.content,
          title: body.title,
          kind: body.kind || 'semantic',
          tags: body.tags || [],
          slotKey: body.slot_key || body.slotKey || null,
          importance: body.importance ?? 0.65,
          supersedes: body.supersedes || null,
          source: body.source || 'web-ui'
        });
        return sendJson(res, 201, result);
      }

      if (pathname === '/api/recall' && req.method === 'POST') {
        const body = await readBody(req);
        const asOf = body.as_of ? Date.parse(body.as_of) : null;
        const result = engine.recall({
          namespace: body.namespace || ns,
          query: body.query || '',
          budgetTokens: Number(body.budget_tokens ?? body.budgetTokens ?? 550),
          disclosure: body.disclosure || 'auto',
          kinds: body.kinds,
          asOf: Number.isFinite(asOf) ? asOf : null,
          includeSuperseded: Boolean(body.include_superseded),
          reinforce: body.reinforce !== false
        });
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/expand' && req.method === 'POST') {
        const body = await readBody(req);
        const result = engine.expand(body.ids || [], body.namespace || '*');
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/consolidate' && req.method === 'POST') {
        const body = await readBody(req);
        const result = engine.consolidate(body.namespace || ns, {
          archiveThreshold: body.archive_threshold ?? 0.22
        });
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/forget' && req.method === 'POST') {
        const body = await readBody(req);
        const result = engine.forget(body.id, body.reason || 'ui_archive');
        return sendJson(res, result.ok ? 200 : 404, result);
      }

      if (pathname === '/api/seed' && req.method === 'POST') {
        const body = await readBody(req);
        const result = seedDemoMemories(engine, body.namespace || ns);
        return sendJson(res, 200, result);
      }

      // --- Static Monochrome Web Inspector ---
      const safePath = pathname === '/' ? '/index.html' : pathname;
      const fullPath = path.resolve(WEB_DIR, '.' + safePath);
      if (fullPath.startsWith(WEB_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  };

  const server = http.createServer(handler);

  server.on('close', () => {
    unsubscribe();
    for (const c of sseClients) c.end();
    sseClients.clear();
    if (!providedEngine) engine.close();
  });

  return { server, engine, handler };
}
