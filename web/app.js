(() => {
  const $ = (id) => document.getElementById(id);
  const COLOR_HEX = {
    green: '#16A34A',
    yellow: '#CA8A04',
    red: '#DC2626'
  };

  let currentNs = 'default';
  let eventSource = null;

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(path, opts = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${path}${sep}ns=${encodeURIComponent(currentNs)}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function connectSse() {
    if (eventSource) eventSource.close();
    const badge = $('sse-badge');
    badge.innerHTML = '<span class="dot dot-yellow"></span>CONNECTING';
    eventSource = new EventSource(`/api/events?ns=${encodeURIComponent(currentNs)}`);
    eventSource.onopen = () => {
      badge.innerHTML = '<span class="dot dot-green"></span>LIVE SSE';
    };
    eventSource.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type && msg.type !== 'connected') refreshAll();
      } catch {
        // Ignore malformed SSE ping
      }
    };
    eventSource.onerror = () => {
      badge.innerHTML = '<span class="dot dot-red"></span>OFFLINE';
    };
  }

  function renderStats(stats) {
    $('kpi-total').textContent = stats.counts.total;
    $('kpi-green').textContent = stats.health.green;
    $('kpi-yellow').textContent = stats.health.yellow;
    $('kpi-red').textContent = stats.health.red;
    $('kpi-savings').textContent = `${stats.telemetry.savings_pct}%`;
    $('kpi-tokens-meta').textContent =
      `L0 ${stats.tokens.active_l0_total} · L1 ${stats.tokens.active_l1_total} · L2 ${stats.tokens.active_l2_total} tok`;
    $('kpi-latency').textContent = `${stats.telemetry.avg_recall_ms} ms`;
    $('kpi-recalls-meta').textContent = `${stats.telemetry.recalls} recalls · ${stats.telemetry.tokens_saved} tok saved`;
    $('kpi-contradictions').textContent = stats.graph.contradictions;
    $('kpi-graph-meta').textContent = `${stats.graph.entities} entities · ${stats.graph.edges} edges`;
    $('kpi-secrets').textContent = stats.telemetry.secrets_redacted;

    renderDecayCurves(stats.decay_curves);
  }

  function renderDecayCurves(curves) {
    const svg = $('decay-svg');
    const W = 540;
    const H = 240;
    const pad = { top: 20, right: 20, bottom: 34, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const x = (day) => pad.left + (day / 30) * plotW;
    const y = (act) => pad.top + (1 - act) * plotH;

    let out = `<rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF" />`;
    // Horizontal threshold bands (strictly monochrome grid + Green/Red indicator threshold lines)
    out += `<line x1="${pad.left}" y1="${y(0.55)}" x2="${W - pad.right}" y2="${y(0.55)}" stroke="#16A34A" stroke-width="1" stroke-dasharray="4 3" />`;
    out += `<text x="${W - pad.right - 2}" y="${y(0.55) - 4}" text-anchor="end" font-family="monospace" font-size="9" fill="#16A34A">ACTIVE >= 0.55</text>`;

    out += `<line x1="${pad.left}" y1="${y(0.25)}" x2="${W - pad.right}" y2="${y(0.25)}" stroke="#DC2626" stroke-width="1" stroke-dasharray="4 3" />`;
    out += `<text x="${W - pad.right - 2}" y="${y(0.25) - 4}" text-anchor="end" font-family="monospace" font-size="9" fill="#DC2626">ARCHIVE &lt; 0.25</text>`;

    // Axes
    out += `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}" stroke="#0A0A0A" stroke-width="1.5" />`;
    out += `<line x1="${pad.left}" y1="${H - pad.bottom}" x2="${W - pad.right}" y2="${H - pad.bottom}" stroke="#0A0A0A" stroke-width="1.5" />`;

    for (const day of [0, 5, 10, 15, 20, 25, 30]) {
      out += `<text x="${x(day)}" y="${H - 14}" text-anchor="middle" font-family="monospace" font-size="10" fill="#525252">${day}d</text>`;
    }
    for (const val of [0, 0.5, 1.0]) {
      out += `<text x="${pad.left - 8}" y="${y(val) + 3}" text-anchor="end" font-family="monospace" font-size="10" fill="#525252">${val.toFixed(1)}</text>`;
    }

    const styles = [
      { key: 'procedural', stroke: '#0A0A0A', width: 2.2, dash: '' },
      { key: 'semantic', stroke: '#404040', width: 1.8, dash: '6 3' },
      { key: 'episodic', stroke: '#737373', width: 1.5, dash: '3 3' },
      { key: 'working', stroke: '#DC2626', width: 1.5, dash: '2 2' }
    ];

    for (const st of styles) {
      const pts = (curves && curves[st.key]) || [];
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p.activation).toFixed(1)}`).join(' ');
      out += `<path d="${d}" fill="none" stroke="${st.stroke}" stroke-width="${st.width}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ''} />`;
    }

    // Legend strip
    const labels = [
      ['procedural (spaced)', '#0A0A0A', ''],
      ['semantic', '#404040', '6 3'],
      ['episodic', '#737373', '3 3'],
      ['working', '#DC2626', '2 2']
    ];
    let lx = pad.left + 8;
    for (const [name, col, dash] of labels) {
      out += `<line x1="${lx}" y1="12" x2="${lx + 16}" y2="12" stroke="${col}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''} />`;
      out += `<text x="${lx + 20}" y="15" font-family="monospace" font-size="9" fill="#0A0A0A">${name}</text>`;
      lx += name.length * 5.8 + 34;
    }

    svg.innerHTML = out;
  }

  function renderGraph(graph) {
    const svg = $('graph-svg');
    const W = 640;
    const H = 380;
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];

    if (nodes.length === 0) {
      svg.innerHTML = `<rect width="${W}" height="${H}" fill="#FFFFFF" /><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="monospace" font-size="12" fill="#666666">Empty hippocampus. Click "Seed Demo" or "+ Remember".</text>`;
      return;
    }

    // Deterministic ring-cluster layout grouped by cognitive kind for crisp readability
    const kindOrder = ['semantic', 'procedural', 'episodic', 'working'];
    const sorted = [...nodes].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
    const pos = new Map();
    const cx = W / 2;
    const cy = H / 2;
    const rx = Math.min(240, 120 + sorted.length * 7);
    const ry = Math.min(145, 85 + sorted.length * 4);

    sorted.forEach((n, idx) => {
      const angle = (2 * Math.PI * idx) / sorted.length - Math.PI / 2;
      const jitter = n.status === 'active' ? 1.0 : 0.62;
      pos.set(n.id, {
        x: cx + Math.cos(angle) * rx * jitter,
        y: cy + Math.sin(angle) * ry * jitter
      });
    });

    let out = `<rect width="${W}" height="${H}" fill="#FFFFFF" />`;
    out += `<defs><marker id="arrow-sup" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#CA8A04" /></marker></defs>`;

    // Edges
    for (const e of edges) {
      const p1 = pos.get(e.source_id);
      const p2 = pos.get(e.target_id);
      if (!p1 || !p2) continue;
      const isSup = e.relation === 'SUPERSEDES';
      out += `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${isSup ? '#CA8A04' : '#A3A3A3'}" stroke-width="${isSup ? 1.8 : 1.1}" ${isSup ? 'stroke-dasharray="5 3" marker-end="url(#arrow-sup)"' : ''} />`;
    }

    // Nodes
    for (const n of sorted) {
      const p = pos.get(n.id);
      const r = 8 + n.activation * 9;
      const indColor = COLOR_HEX[n.health.color] || '#0A0A0A';
      const label = (n.slot_key || n.title).slice(0, 18);
      out += `
        <g class="graph-node" data-id="${escapeHtml(n.id)}" style="cursor:pointer">
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${n.status === 'active' ? '#FFFFFF' : '#F5F5F5'}" stroke="#0A0A0A" stroke-width="${n.status === 'active' ? 1.8 : 1.1}" ${n.status !== 'active' ? 'stroke-dasharray="3 2"' : ''} />
          <circle cx="${(p.x + r * 0.65).toFixed(1)}" cy="${(p.y - r * 0.65).toFixed(1)}" r="3.6" fill="${indColor}" stroke="#FFFFFF" stroke-width="1" />
          <text x="${p.x.toFixed(1)}" y="${(p.y + r + 12).toFixed(1)}" text-anchor="middle" font-family="monospace" font-size="9" fill="#0A0A0A">${escapeHtml(label)}</text>
        </g>`;
    }

    svg.innerHTML = out;
    svg.querySelectorAll('.graph-node').forEach((g) => {
      g.addEventListener('click', () => inspectMemory(g.dataset.id));
    });
  }

  async function inspectMemory(id) {
    try {
      const res = await api('/api/expand', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
      const m = res.memories[0];
      if (!m) return;
      const box = $('node-inspector');
      box.classList.remove('hidden');
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div>
            <span class="dot dot-${m.health.color}"></span>
            <strong>${escapeHtml(m.id)}</strong>
            <span class="tag">${escapeHtml(m.kind)}</span>
            <span class="tag">${escapeHtml(m.health.label)}</span>
            ${m.slot_key ? `<span class="tag">${escapeHtml(m.slot_key)}</span>` : ''}
          </div>
          <span>ACT-R=${m.activation} · S=${m.stability} · L0/L1/L2=${m.tokens_l0}/${m.tokens_l1}/${m.tokens_l2}</span>
        </div>
        <pre>${escapeHtml(m.content)}</pre>
        <div style="margin-top:6px;color:#525252;">
          Entities: ${m.entities.map((e) => escapeHtml(e.name)).join(', ') || 'none'}
        </div>
      `;
    } catch (err) {
      showToast(err.message);
    }
  }

  function renderTimeline(tl) {
    const list = $('contradictions-list');
    if (!tl.contradictions || tl.contradictions.length === 0) {
      list.innerHTML = '<div class="empty-state">No contradictions resolved yet.</div>';
      return;
    }
    list.innerHTML = tl.contradictions
      .map(
        (c) => `
        <div class="contradiction-row">
          <div><span class="dot dot-yellow"></span><strong>${escapeHtml(c.slot_key || 'transition')}</strong> · ${escapeHtml(c.reason)}</div>
          <div style="margin-top:3px;color:#525252;">
            <s>${escapeHtml(c.older_title)}</s> → <strong>${escapeHtml(c.newer_title)}</strong>
          </div>
        </div>`
      )
      .join('');
  }

  function renderVault(data) {
    const tbody = $('vault-tbody');
    const memories = data.memories || [];
    if (memories.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No memories match current filter.</div></td></tr>';
      return;
    }
    tbody.innerHTML = memories
      .map(
        (m) => `
        <tr>
          <td><span class="dot dot-${m.health.color}"></span>${escapeHtml(m.health.label)}</td>
          <td>${escapeHtml(m.id)}</td>
          <td><span class="tag">${escapeHtml(m.kind)}</span></td>
          <td>
            <div class="vault-title">${escapeHtml(m.title)}</div>
            ${m.slot_key ? `<div class="vault-slot">slot: ${escapeHtml(m.slot_key)}</div>` : ''}
          </td>
          <td>${m.activation.toFixed(2)} <span style="color:#666">(×${m.access_count})</span></td>
          <td>${m.tokens_l0} / ${m.tokens_l1} / ${m.tokens_l2}</td>
          <td>
            <button class="btn btn-sm" data-expand="${escapeHtml(m.id)}">L2</button>
            ${m.status === 'active' ? `<button class="btn btn-sm" data-forget="${escapeHtml(m.id)}">Archive</button>` : ''}
          </td>
        </tr>`
      )
      .join('');

    tbody.querySelectorAll('[data-expand]').forEach((btn) => {
      btn.addEventListener('click', () => inspectMemory(btn.dataset.expand));
    });
    tbody.querySelectorAll('[data-forget]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api('/api/forget', { method: 'POST', body: JSON.stringify({ id: btn.dataset.forget }) });
        showToast(`Archived ${btn.dataset.forget}`);
        refreshAll();
      });
    });
  }

  async function runRecall(ev) {
    if (ev) ev.preventDefault();
    const query = $('recall-query').value.trim();
    const budget = Number($('recall-budget').value);
    const disclosure = $('recall-disclosure').value;
    const includeSuperseded = $('recall-superseded').checked;

    try {
      const res = await api('/api/recall', {
        method: 'POST',
        body: JSON.stringify({
          query,
          budget_tokens: budget,
          disclosure,
          include_superseded: includeSuperseded,
          reinforce: false
        })
      });

      const meter = $('recall-meter');
      meter.classList.remove('hidden');
      $('meter-label').innerHTML =
        `<span class="dot dot-green"></span>Emitted <strong>${res.tokens_used}</strong> / ${res.budget_tokens} tok — Saved <strong>${res.savings_pct}%</strong> (${res.tokens_saved} tok vs naive ${res.naive_tokens} tok)`;
      $('meter-latency').textContent = `${res.latency_ms} ms · ${res.memories.length}/${res.total_candidates} candidates`;
      const pct = res.naive_tokens > 0 ? Math.min(100, (res.tokens_used / res.naive_tokens) * 100) : 0;
      $('meter-fill').style.width = `${pct.toFixed(1)}%`;

      const box = $('recall-results');
      if (res.memories.length === 0) {
        box.innerHTML = '<div class="empty-state">No matching memories found for query.</div>';
        return;
      }
      box.innerHTML = res.memories
        .map(
          (m) => `
          <div class="recall-item">
            <div class="recall-item-head">
              <div>
                <span class="dot dot-${m.health.color}"></span>
                <strong>${escapeHtml(m.id)}</strong>
                <span class="tag tag-invert">${escapeHtml(m.disclosure_tier)} (${m.tokens_emitted} tok)</span>
                <span class="tag">${escapeHtml(m.kind)}</span>
                ${m.signals.multi_hop ? '<span class="tag tag-hop">PPR MULTI-HOP</span>' : ''}
              </div>
              <div style="color:#525252">
                score=${m.score} · rrf=${m.signals.rrf} · ppr=${m.signals.ppr} · act-r=${m.signals.actr}
                <button class="btn btn-sm" style="margin-left:8px" data-expand-recall="${escapeHtml(m.id)}">Expand L2</button>
              </div>
            </div>
            <p class="recall-text">${escapeHtml(m.emitted_text)}</p>
          </div>`
        )
        .join('');

      box.querySelectorAll('[data-expand-recall]').forEach((btn) => {
        btn.addEventListener('click', () => inspectMemory(btn.dataset.expandRecall));
      });
    } catch (err) {
      showToast(err.message);
    }
  }

  async function refreshAll() {
    try {
      const kind = $('filter-kind').value;
      const status = $('filter-status').value;
      const [stats, graph, tl, vault] = await Promise.all([
        api('/api/stats'),
        api('/api/graph'),
        api('/api/timeline'),
        api(`/api/memories?kind=${encodeURIComponent(kind)}&status=${encodeURIComponent(status)}`)
      ]);
      renderStats(stats);
      renderGraph(graph);
      renderTimeline(tl);
      renderVault(vault);
    } catch (err) {
      showToast(err.message);
    }
  }

  // Event wiring
  $('recall-budget').addEventListener('input', (e) => {
    $('budget-val').textContent = e.target.value;
  });
  $('recall-form').addEventListener('submit', runRecall);
  $('filter-kind').addEventListener('change', refreshAll);
  $('filter-status').addEventListener('change', refreshAll);

  $('ns-input').addEventListener('change', (e) => {
    currentNs = e.target.value.trim() || 'default';
    connectSse();
    refreshAll();
  });

  $('btn-seed').addEventListener('click', async () => {
    try {
      const res = await api('/api/seed', { method: 'POST', body: '{}' });
      showToast(`Seeded ${res.seeded} engineering memories into "${currentNs}"`);
      refreshAll();
      $('recall-query').value = 'deploy timeout healthcheck session store';
      runRecall();
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btn-sleep').addEventListener('click', async () => {
    try {
      const res = await api('/api/consolidate', { method: 'POST', body: '{}' });
      showToast(`Sleep done: refreshed=${res.refreshed}, merged=${res.merged_duplicates}, promoted=${res.promoted_clusters}, archived=${res.archived_stale}`);
      refreshAll();
    } catch (err) {
      showToast(err.message);
    }
  });

  const dlg = $('add-dialog');
  $('btn-open-add').addEventListener('click', () => dlg.showModal());
  $('btn-close-add').addEventListener('click', () => dlg.close());
  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const content = $('add-content').value.trim();
    if (!content) return;
    const tags = $('add-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const res = await api('/api/remember', {
        method: 'POST',
        body: JSON.stringify({
          content,
          kind: $('add-kind').value,
          slot_key: $('add-slot').value.trim() || null,
          tags,
          importance: Number($('add-importance').value)
        })
      });
      dlg.close();
      $('add-content').value = '';
      let msg = `Stored ${res.memory.id} (${res.action})`;
      if (res.secretsRedacted > 0) msg += ` · REDACTED ${res.secretsRedacted} SECRET(S)`;
      if (res.superseded.length > 0) msg += ` · SUPERSEDED ${res.superseded.length} OLD FACT(S)`;
      showToast(msg);
      refreshAll();
    } catch (err) {
      showToast(err.message);
    }
  });

  connectSse();
  refreshAll();
})();
