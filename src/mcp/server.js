import { HippoCacheEngine } from '../core/engine.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'hippo-cache',
  version: '1.0.0'
};

export const MCP_TOOLS = [
  {
    name: 'memory_recall',
    description:
      'Retrieve token-budgeted memories using hybrid FTS5 BM25 + 512-d vector search, HippoRAG Personalized PageRank multi-hop graph spread, ACT-R decay activation, and submodular knapsack packing. Defaults to progressive L0/L1 disclosure to save 75-94% tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query, file path, symbol name, or error message.' },
        namespace: { type: 'string', description: 'Project/repo namespace (default: "default").' },
        budget_tokens: { type: 'number', description: 'Hard maximum output token budget (default: 550).' },
        disclosure: {
          type: 'string',
          enum: ['auto', 'l0', 'l1', 'l2'],
          description: 'Disclosure tier: auto (L1 anchors + L0 pointers), l0 (titles only), l1 (abstracts), l2 (verbatim).'
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['working', 'episodic', 'semantic', 'procedural'] },
          description: 'Optional filter by cognitive memory kind.'
        },
        as_of: { type: 'string', description: 'Optional ISO-8601 timestamp for bi-temporal time-travel recall.' },
        include_superseded: { type: 'boolean', description: 'Include historically superseded facts (default: false).' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_remember',
    description:
      'Store a memory with automatic secret redaction, exact + SimHash deduplication, code/entity graph indexing, bi-temporal contradiction supersession, and Zettelkasten auto-linking.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full memory text (architectural decision, root cause, fix rule, or session discovery).' },
        title: { type: 'string', description: 'Optional concise L0 title (auto-extracted if omitted).' },
        kind: {
          type: 'string',
          enum: ['working', 'episodic', 'semantic', 'procedural'],
          description: 'Cognitive memory store (default: "semantic").'
        },
        namespace: { type: 'string', description: 'Project/repo namespace (default: "default").' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags/keywords.' },
        slot_key: { type: 'string', description: 'Optional decision slot (e.g. test_runner, session_store, auth_strategy) for contradiction tracking.' },
        importance: { type: 'number', description: 'Salience weight 0.1..1.0 (default: 0.65).' },
        supersedes: { type: 'string', description: 'Optional older mem_* ID explicitly superseded by this memory.' },
        source: { type: 'string', description: 'Originating agent (e.g. claude-code, codex, cursor).' }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_expand',
    description:
      'RLM-style on-demand verbatim L2 hydration for specific memory IDs returned by memory_recall, including linked graph neighbors and entities.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of mem_* IDs to hydrate in full verbatim L2.'
        },
        namespace: { type: 'string', description: 'Project namespace (default: "*").' }
      },
      required: ['ids']
    }
  },
  {
    name: 'memory_consolidate',
    description:
      'Run cognitive sleep-cycle consolidation: refresh ACT-R activations, merge near-duplicate episodes, promote recurring episodic clusters to semantic/procedural knowledge, and archive stale low-activation noise.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Project namespace (default: "default").' },
        archive_threshold: { type: 'number', description: 'Activation threshold below which unpinned old memories archive (default: 0.22).' }
      }
    }
  },
  {
    name: 'memory_graph',
    description: 'Inspect the associative knowledge graph (memory nodes, Zettelkasten/supersession edges, entity hubs, and Green/Yellow/Red health indicators).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Project namespace (default: "default").' },
        limit: { type: 'number', description: 'Maximum memory nodes to return (default: 40).' }
      }
    }
  },
  {
    name: 'memory_forget',
    description: 'Soft-archive a memory by ID (sets valid_until=now while preserving bi-temporal auditability).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID (mem_*) to archive.' },
        reason: { type: 'string', description: 'Optional reason for archiving.' }
      },
      required: ['id']
    }
  },
  {
    name: 'memory_stats',
    description: 'Return token-savings telemetry, memory health distribution (green/yellow/red), graph density, contradiction count, and secret redactions.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Project namespace (default: "default").' }
      }
    }
  },
  {
    name: 'memory_timeline',
    description: 'Inspect bi-temporal audit log of recent facts and automatic contradiction/supersession resolutions.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Project namespace (default: "default").' },
        limit: { type: 'number', description: 'Maximum entries (default: 25).' }
      }
    }
  }
];

export function handleMcpRequest(engine, msg, defaultNamespace = 'default') {
  const { id, method, params = {} } = msg;

  // Notifications have no id and expect no response.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: SERVER_INFO
      }
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS }
    };
  }

  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          {
            uri: `hippo://${defaultNamespace}/stats`,
            name: 'hippo-cache telemetry & health',
            mimeType: 'application/json'
          }
        ]
      }
    };
  }

  if (method === 'resources/read') {
    const stats = engine.getStats(defaultNamespace);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        contents: [
          {
            uri: params.uri || `hippo://${defaultNamespace}/stats`,
            mimeType: 'application/json',
            text: JSON.stringify(stats, null, 2)
          }
        ]
      }
    };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    const ns = args.namespace || defaultNamespace;

    try {
      let textOut = '';
      if (name === 'memory_recall') {
        const asOf = args.as_of ? Date.parse(args.as_of) : null;
        const res = engine.recall({
          query: args.query,
          namespace: ns,
          budgetTokens: args.budget_tokens ?? 550,
          disclosure: args.disclosure || 'auto',
          kinds: args.kinds,
          asOf: Number.isFinite(asOf) ? asOf : null,
          includeSuperseded: Boolean(args.include_superseded)
        });
        textOut = res.context_block;
      } else if (name === 'memory_remember') {
        const res = engine.remember({
          content: args.content,
          title: args.title,
          kind: args.kind || 'semantic',
          namespace: ns,
          tags: args.tags || [],
          slotKey: args.slot_key || null,
          importance: args.importance ?? 0.65,
          supersedes: args.supersedes || null,
          source: args.source || 'mcp-agent'
        });
        const compact = {
          action: res.action,
          id: res.memory.id,
          kind: res.memory.kind,
          health: res.memory.health.label,
          slot_key: res.memory.slot_key,
          tokens: { l0: res.memory.tokens_l0, l1: res.memory.tokens_l1, l2: res.memory.tokens_l2 },
          secrets_redacted: res.secretsRedacted,
          superseded: res.superseded,
          linked_edges: res.linkedEdges
        };
        textOut = JSON.stringify(compact, null, 2);
      } else if (name === 'memory_expand') {
        const res = engine.expand(args.ids || [], args.namespace || '*');
        textOut = JSON.stringify(res, null, 2);
      } else if (name === 'memory_consolidate') {
        const res = engine.consolidate(ns, {
          archiveThreshold: args.archive_threshold ?? 0.22
        });
        textOut = JSON.stringify(res, null, 2);
      } else if (name === 'memory_graph') {
        const res = engine.getGraph(ns, { limit: args.limit ?? 40 });
        textOut = JSON.stringify(res, null, 2);
      } else if (name === 'memory_forget') {
        const res = engine.forget(args.id, args.reason || 'agent_forget');
        textOut = JSON.stringify(res, null, 2);
      } else if (name === 'memory_stats') {
        const res = engine.getStats(ns);
        const { decay_curves, ...summaryStats } = res;
        textOut = JSON.stringify(summaryStats, null, 2);
      } else if (name === 'memory_timeline') {
        const res = engine.getTimeline(ns, args.limit ?? 25);
        textOut = JSON.stringify(res, null, 2);
      } else {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` }
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: textOut }]
        }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `hippo-cache error: ${err.message}` }]
        }
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

/**
 * Runs stdio MCP transport supporting both newline-delimited JSON-RPC (2024-11-05+)
 * and LSP-style Content-Length framed messages transparently.
 */
export function startStdioMcpServer({ dbPath = '.hippo-cache/memory.db', namespace = 'default' } = {}) {
  const engine = new HippoCacheEngine(dbPath);
  let buffer = Buffer.alloc(0);
  let useContentLengthFraming = false;

  const send = (payload) => {
    const json = JSON.stringify(payload);
    if (useContentLengthFraming) {
      const len = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${len}\r\n\r\n${json}`);
    } else {
      process.stdout.write(json + '\n');
    }
  };

  const dispatch = (rawJson) => {
    const trimmed = rawJson.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const response = handleMcpRequest(engine, msg, namespace);
    if (response) send(response);
  };

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const str = buffer.toString('utf8');
      if (str.startsWith('Content-Length:')) {
        useContentLengthFraming = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const len = parseInt(match[1], 10);
        const total = headerEnd + 4 + len;
        if (buffer.length < total) break;
        const body = buffer.slice(headerEnd + 4, total).toString('utf8');
        buffer = buffer.slice(total);
        dispatch(body);
      } else {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl).toString('utf8');
        buffer = buffer.slice(nl + 1);
        dispatch(line);
      }
    }
  });

  process.stdin.on('end', () => {
    engine.close();
  });

  process.on('SIGINT', () => {
    engine.close();
    process.exit(0);
  });

  return engine;
}
