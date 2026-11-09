// IncuBrix Admin Dashboard Client Controller
const API_BASE = '/api/v1';

// Global state
let currentView = 'overview';
let destinationsCache = [];
let connectorsCache = [];
let pollingJobTimer = null;

// Helper: Generate fresh UUID for Idempotency-Key
function getFreshIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'idem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 12);
}

// Helper: Show toast notification
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

// Navigation switcher
function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const activeBtn = document.querySelector(`.nav-item[data-view="${viewName}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  document.querySelectorAll('.view-pane').forEach(el => el.style.display = 'none');
  const activePane = document.getElementById(`view-${viewName}`);
  if (activePane) activePane.style.display = 'block';

  // Load relevant view data
  switch (viewName) {
    case 'overview':
      loadDashboardOverview();
      break;
    case 'destinations':
      loadDestinationsTable();
      break;
    case 'workspace':
      setupWorkspace();
      break;
    case 'connectors':
      loadConnectorsView();
      break;
    case 'recommender':
      setupRecommenderView();
      break;
    case 'assisted':
      setupAssistedView();
      break;
    case 'audit':
      loadAuditLogs();
      break;
  }
}

// ----------------------------------------------------
// 1. OVERVIEW VIEW
// ----------------------------------------------------
async function loadDashboardOverview() {
  try {
    const statsRes = await fetch(`${API_BASE}/audit/dashboard-stats`);
    if (statsRes.ok) {
      const stats = await statsRes.json();
      document.getElementById('stat-total-destinations').textContent = stats.total_destinations;
      document.getElementById('stat-certified-destinations').textContent = stats.certified_destinations;
      document.getElementById('stat-certification-rate').textContent = `${stats.certification_rate}%`;
      document.getElementById('stat-total-jobs').textContent = stats.total_jobs;
      document.getElementById('stat-rule-violations').textContent = stats.rule_violations_caught;
    }

    const jobsRes = await fetch(`${API_BASE}/jobs?limit=8`);
    if (jobsRes.ok) {
      const data = await jobsRes.json();
      const tbody = document.getElementById('overview-jobs-tbody');
      tbody.innerHTML = '';

      if (!data.jobs || data.jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">No recent publication jobs. Use the Workspace to publish!</td></tr>';
        return;
      }

      data.jobs.forEach(job => {
        const tr = document.createElement('tr');
        const badgeClass = job.status === 'succeeded' ? 'badge-certified' : (job.status === 'failed' ? 'badge-failed' : 'badge-uncertified');
        tr.innerHTML = `
          <td><strong>${job.title || 'Untitled'}</strong></td>
          <td><span class="badge badge-platform">${job.connector_key}</span> ${job.destination_name || ''}</td>
          <td><span class="badge ${badgeClass}">${job.status}</span></td>
          <td>${job.live_url ? `<a href="${job.live_url}" target="_blank" style="color:var(--accent-teal);">Open Link ↗</a>` : (job.error_code || '—')}</td>
          <td>${new Date(job.created_at).toLocaleTimeString()}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    showToast(`Failed to load overview: ${err.message}`, 'error');
  }
}

// ----------------------------------------------------
// 2. DESTINATION CATALOGUE VIEW
// ----------------------------------------------------
async function loadDestinationsTable(page = 1) {
  const search = document.getElementById('dest-search-input')?.value || '';
  const platform = document.getElementById('dest-platform-filter')?.value || '';
  const status = document.getElementById('dest-status-filter')?.value || '';

  try {
    const url = new URL(`${window.location.origin}${API_BASE}/destinations`);
    url.searchParams.set('page', page);
    url.searchParams.set('limit', 15);
    if (search) url.searchParams.set('search', search);
    if (platform) url.searchParams.set('platform', platform);
    if (status) url.searchParams.set('status', status);

    const res = await fetch(url);
    const data = await res.json();
    destinationsCache = data.items || [];

    const tbody = document.getElementById('destinations-tbody');
    tbody.innerHTML = '';

    if (destinationsCache.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 20px;">No destinations match filter.</td></tr>';
      return;
    }

    destinationsCache.forEach(dest => {
      const tr = document.createElement('tr');
      const statusBadge = dest.status === 'certified'
        ? '<span class="badge badge-certified">CERTIFIED</span>'
        : (dest.status === 'degraded' ? '<span class="badge badge-degraded">DEGRADED</span>' : '<span class="badge badge-uncertified">UNCERTIFIED</span>');

      tr.innerHTML = `
        <td><strong>${dest.name}</strong><br><span style="font-size:11px; color:var(--text-muted);">${dest.url}</span></td>
        <td><span class="badge badge-platform">${dest.platform_key}</span></td>
        <td>${dest.category || 'General'}</td>
        <td>${dest.frequency_cap || '1/7d'}</td>
        <td>★ ${dest.relevance_score || 3}/5</td>
        <td>${statusBadge}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="runCertification('${dest.id}')">Certify</button>
          <button class="btn btn-secondary btn-sm" onclick="openPublishForDest('${dest.id}')">Post</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Pagination info
    const pageInfo = document.getElementById('dest-pagination-info');
    if (pageInfo) {
      pageInfo.textContent = `Page ${data.pagination.page} of ${data.pagination.totalPages || 1} (${data.pagination.total} destinations)`;
    }
  } catch (err) {
    showToast(`Error fetching destinations: ${err.message}`, 'error');
  }
}

// ----------------------------------------------------
// 3. PUBLISHING WORKSPACE
// ----------------------------------------------------
function updateWorkspaceModeForDestination() {
  const select = document.getElementById('workspace-destination-select');
  const btn = document.getElementById('workspace-publish-btn');
  const pill = document.getElementById('sidebar-mode-pill');
  const dot = document.getElementById('sidebar-mode-dot');
  const text = document.getElementById('sidebar-mode-text');
  if (!select || !btn) return;

  const destId = select.value;
  const dest = destinationsCache.find(d => d.id === destId);
  const isLive = dest && (dest.simulation_mode === 0 || dest.simulation_mode === false || dest.simulation_mode === '0');

  if (isLive) {
    btn.textContent = 'Publish (LIVE)';
    btn.classList.add('btn-live');
    if (pill) pill.classList.add('live-pill');
    if (dot) dot.classList.add('pulse-dot-live');
    if (text) text.textContent = `LIVE Mode Active (${dest.platform_key})`;
  } else {
    btn.textContent = 'Publish (simulation)';
    btn.classList.remove('btn-live');
    if (pill) pill.classList.remove('live-pill');
    if (dot) dot.classList.remove('pulse-dot-live');
    if (text) text.textContent = 'Simulation Mode Active';
  }
}

async function setupWorkspace() {
  const select = document.getElementById('workspace-destination-select');
  if (!select) return;

  if (destinationsCache.length === 0) {
    const res = await fetch(`${API_BASE}/destinations?limit=200`);
    if (res.ok) {
      const data = await res.json();
      destinationsCache = data.items || [];
    }
  }

  select.innerHTML = '<option value="">Select Target Destination...</option>';
  destinationsCache.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    const isLive = d.simulation_mode === 0 || d.simulation_mode === false || d.simulation_mode === '0';
    opt.textContent = `[${d.platform_key.toUpperCase()}${isLive ? ' • LIVE' : ''}] ${d.name} (${d.category || 'General'})`;
    select.appendChild(opt);
  });

  updateWorkspaceModeForDestination();
}

function openPublishForDest(destId) {
  switchView('workspace');
  setTimeout(() => {
    const select = document.getElementById('workspace-destination-select');
    if (select) {
      select.value = destId;
      updateWorkspaceModeForDestination();
    }
  }, 200);
}

// Pre-check posting rules
async function evaluateRulesInWorkspace() {
  const select = document.getElementById('workspace-destination-select');
  const destId = select ? select.value : '';
  const title = document.getElementById('workspace-title').value;
  const body = document.getElementById('workspace-body').value;
  const canonicalUrl = document.getElementById('workspace-canonical').value;
  const isAi = document.getElementById('workspace-is-ai').checked;
  const isPromo = document.getElementById('workspace-is-promo').checked;

  if (!destId) {
    showToast('Please select a target destination first', 'error');
    return;
  }

  const dest = destinationsCache.find(d => d.id === destId);

  const resultContainer = document.getElementById('workspace-rules-result');
  resultContainer.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Evaluating posting rules against destination specifications...</div>';

  try {
    const res = await fetch(`${API_BASE}/publish/rules/evaluate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': getFreshIdempotencyKey()
      },
      body: JSON.stringify({
        destination_id: destId,
        title,
        body,
        canonical_url: canonicalUrl,
        is_ai_generated: isAi,
        is_promotional: isPromo
      })
    });

    const data = await res.json();
    resultContainer.innerHTML = '';

    // 1. Decision Banner
    const isAllow = data.decision === 'ALLOW';
    const isWarn = data.decision === 'RESCHEDULE';
    const decisionBanner = document.createElement('div');
    decisionBanner.className = `rule-item ${isAllow ? 'rule-pass' : (isWarn ? 'rule-warn' : 'rule-fail')}`;
    decisionBanner.innerHTML = `
      <span class="rule-icon">${isAllow ? '✓' : (isWarn ? '⏱' : '✕')}</span>
      <div style="flex:1;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>DECISION: ${data.decision}</strong>
          <span class="badge ${isAllow ? 'badge-certified' : (isWarn ? 'badge-platform' : 'badge-failed')}">${data.triggered_rules && data.triggered_rules.length > 0 ? data.triggered_rules.join(', ') : 'PASS'}</span>
        </div>
        <div style="font-size:12px; margin-top:4px;">${data.reasons && data.reasons.length > 0 ? data.reasons.join('<br>') : 'All destination checks passed! Content complies with destination rules.'}</div>
        ${data.reschedule_after ? `<div style="font-size:11px; margin-top:4px; color:var(--status-warning);">Reschedule suggested after: ${new Date(data.reschedule_after).toLocaleString()}</div>` : ''}
      </div>
    `;
    resultContainer.appendChild(decisionBanner);

    // 2. Comprehensive Breakdown of WHY Decision was Made
    const breakdown = document.createElement('div');
    breakdown.style.marginTop = '12px';
    breakdown.style.fontSize = '12px';
    breakdown.style.background = 'var(--bg-surface)';
    breakdown.style.border = '1px solid var(--border-subtle)';
    breakdown.style.borderRadius = 'var(--radius-md)';
    breakdown.style.padding = '12px';

    const destPromoBan = dest ? (dest.self_promo_allowed === 0 || dest.self_promo_allowed === false || dest.disallow_promotional === 1) : false;
    const destAiReq = dest ? (dest.disclosure_required === 1 || dest.disclosure_required === true || dest.require_ai_disclosure === 1) : false;
    const destFreqCap = dest ? (dest.frequency_cap || 'None (unlimited)') : 'Unknown';
    const destLinkPolicy = dest ? (dest.link_policy || 'allowed') : 'allowed';
    const linksFound = ((body || '').match(/https?:\/\/[^\s]+/gi) || []).length + (canonicalUrl ? 1 : 0);

    breakdown.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px; color:var(--text-primary); border-bottom:1px solid var(--border-subtle); padding-bottom:4px;">
        Rule Evaluation & Reason Breakdown:
      </div>

      <div style="margin-bottom:8px; line-height:1.4;">
        <strong>1. Self-Promotion Policy (DEST_RULE_SELF_PROMO):</strong><br>
        <span style="color:var(--text-muted);">&bull; Destination Rule:</span> <code>self_promo_allowed = ${dest ? (destPromoBan ? '0 (prohibited)' : '1 (allowed)') : 'N/A'}</code><br>
        <span style="color:var(--text-muted);">&bull; Judgment Basis:</span> <em>Self-promotion is judged directly from the "Self-Promotional Material" checkbox flag.</em><br>
        <span style="color:var(--text-muted);">&bull; Flag State:</span> <code>${isPromo ? 'CHECKED (is_promotional = true)' : 'UNCHECKED (is_promotional = false)'}</code><br>
        <span style="color:var(--text-muted);">&bull; Result:</span> ${destPromoBan && isPromo ? '<span style="color:var(--status-error); font-weight:600;">BLOCKED — Destination prohibits self-promotion and promotional flag is checked.</span>' : '<span style="color:var(--status-success); font-weight:600;">PASSED — No self-promotion violation.</span>'}
      </div>

      <div style="margin-bottom:8px; line-height:1.4;">
        <strong>2. AI Disclosure Policy (DEST_RULE_AI_DISCLOSURE):</strong><br>
        <span style="color:var(--text-muted);">&bull; Destination Rule:</span> <code>disclosure_required = ${destAiReq ? '1 (required)' : '0 (optional)'}</code><br>
        <span style="color:var(--text-muted);">&bull; Flag State:</span> <code>${isAi ? 'CHECKED (is_ai_generated = true)' : 'UNCHECKED (is_ai_generated = false)'}</code><br>
        <span style="color:var(--text-muted);">&bull; Result:</span> ${destAiReq && isAi && !body.includes('[AI Disclosure') ? '<span style="color:var(--status-error); font-weight:600;">BLOCKED — Disclosure phrase required for AI-generated posts.</span>' : '<span style="color:var(--status-success); font-weight:600;">PASSED — AI disclosure requirements satisfied.</span>'}
      </div>

      <div style="margin-bottom:8px; line-height:1.4;">
        <strong>3. Frequency Cap Policy (DEST_RULE_FREQUENCY_CAP):</strong><br>
        <span style="color:var(--text-muted);">&bull; Destination Rule:</span> <code>frequency_cap = ${destFreqCap}</code><br>
        <span style="color:var(--text-muted);">&bull; Result:</span> ${data.decision === 'RESCHEDULE' ? '<span style="color:var(--status-warning); font-weight:600;">RESCHEDULE — Destination posting rate limit reached.</span>' : '<span style="color:var(--status-success); font-weight:600;">PASSED — Rate limits respected.</span>'}
      </div>

      <div style="margin-bottom:4px; line-height:1.4;">
        <strong>4. Link Policy (DEST_RULE_LINK_POLICY):</strong><br>
        <span style="color:var(--text-muted);">&bull; Destination Rule:</span> <code>link_policy = ${destLinkPolicy}</code> (Found: ${linksFound} link(s))<br>
        <span style="color:var(--text-muted);">&bull; Result:</span> ${data.triggered_rules && data.triggered_rules.includes('DEST_RULE_LINK_POLICY') ? '<span style="color:var(--status-error); font-weight:600;">BLOCKED — Link count violates destination policy.</span>' : '<span style="color:var(--status-success); font-weight:600;">PASSED — Conforms to link policy.</span>'}
      </div>
    `;
    resultContainer.appendChild(breakdown);

  } catch (err) {
    resultContainer.innerHTML = `<div style="color:var(--status-error);">Rule evaluation error: ${err.message}</div>`;
  }
}

// Auto-tailor content
async function tailorContentInWorkspace() {
  const destId = document.getElementById('workspace-destination-select').value;
  const title = document.getElementById('workspace-title').value;
  const body = document.getElementById('workspace-body').value;
  const canonicalUrl = document.getElementById('workspace-canonical').value;
  const isAi = document.getElementById('workspace-is-ai').checked;

  if (!destId) {
    showToast('Please select a destination to tailor content for', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/publish/tailor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': getFreshIdempotencyKey()
      },
      body: JSON.stringify({
        destination_id: destId,
        title,
        body,
        canonical_url: canonicalUrl,
        is_ai_generated: isAi
      })
    });

    if (res.ok) {
      const tailored = await res.json();
      document.getElementById('workspace-title').value = tailored.title;
      document.getElementById('workspace-body').value = tailored.body;
      showToast(`Content successfully tailored for ${tailored.platform_key} conventions!`, 'success');
      evaluateRulesInWorkspace();
    }
  } catch (err) {
    showToast(`Tailoring failed: ${err.message}`, 'error');
  }
}

// Publish post (in simulation mode or live mode per destination)
async function publishFromWorkspace() {
  const destId = document.getElementById('workspace-destination-select').value;
  const title = document.getElementById('workspace-title').value;
  const body = document.getElementById('workspace-body').value;
  const canonicalUrl = document.getElementById('workspace-canonical').value;
  const isAi = document.getElementById('workspace-is-ai').checked;
  const isPromo = document.getElementById('workspace-is-promo').checked;

  if (!destId || !title || !body) {
    showToast('Please fill in destination, title, and body', 'error');
    return;
  }

  const dest = destinationsCache.find(d => d.id === destId);
  const isLive = dest && (dest.simulation_mode === 0 || dest.simulation_mode === false || dest.simulation_mode === '0');

  // Confirmation before publishing to live destination
  if (isLive) {
    const confirmed = window.confirm(
      `⚠️ CONFIRM LIVE PUBLICATION\n\nDestination: ${dest.name} (${dest.url})\nPlatform: ${dest.platform_key.toUpperCase()}\n\nWARNING: This destination is in LIVE mode (simulation_mode = 0). A real publication will be created on the live platform.\n\nDo you want to proceed with live publication?`
    );
    if (!confirmed) {
      showToast('Live publication cancelled by user.', 'info');
      return;
    }
  }

  const progressBar = document.getElementById('workspace-progress-bar');
  const progressFill = document.getElementById('workspace-progress-fill');
  const statusText = document.getElementById('workspace-job-status');
  const manifestPre = document.getElementById('workspace-manifest-pre');

  progressBar.style.display = 'block';
  progressFill.style.width = '20%';
  statusText.textContent = `Submitting ${isLive ? 'LIVE' : 'simulation'} job with Idempotency-Key...`;
  manifestPre.textContent = '';

  const idemKey = getFreshIdempotencyKey();

  try {
    const res = await fetch(`${API_BASE}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey
      },
      body: JSON.stringify({
        destination_id: destId,
        title,
        body,
        canonical_url: canonicalUrl,
        is_ai_generated: isAi,
        is_promotional: isPromo,
        simulation: !isLive
      })
    });

    const bodyData = await res.json();
    if (!res.ok) {
      progressBar.style.display = 'none';
      throw new Error(bodyData.error?.message || 'Publishing blocked or failed');
    }

    const jobId = bodyData.job_id;
    statusText.textContent = `Job Accepted (${jobId}). Polling progress...`;
    progressFill.style.width = '50%';

    // Poll job status
    let attempts = 0;
    if (pollingJobTimer) clearInterval(pollingJobTimer);

    pollingJobTimer = setInterval(async () => {
      attempts++;
      const pollRes = await fetch(`${API_BASE}/jobs/${jobId}`);
      if (pollRes.ok) {
        const job = await pollRes.json();
        progressFill.style.width = `${Math.max(50, job.progress)}%`;
        statusText.textContent = `Status: ${job.status.toUpperCase()} (${job.progress}%)`;

        if (job.status === 'succeeded') {
          clearInterval(pollingJobTimer);
          progressFill.style.width = '100%';
          statusText.innerHTML = `✓ Successfully Published! <a href="${job.live_url}" target="_blank" style="color:var(--accent-teal); font-weight:600;">View Live Post ↗</a>`;
          manifestPre.textContent = JSON.stringify(job.manifest || {}, null, 2);
          showToast('Publication successful!', 'success');
        } else if (job.status === 'failed') {
          clearInterval(pollingJobTimer);
          statusText.innerHTML = `<span style="color:var(--status-error);">✕ Failed: ${job.error?.message || 'Execution error'}</span>`;
          showToast(`Publishing failed: ${job.error?.message}`, 'error');
        }
      }

      if (attempts > 30) {
        clearInterval(pollingJobTimer);
        statusText.textContent = 'Job polling timed out.';
      }
    }, 600);

  } catch (err) {
    statusText.innerHTML = `<span style="color:var(--status-error);">✕ ${err.message}</span>`;
    showToast(err.message, 'error');
  }
}

// ----------------------------------------------------
// 4. CERTIFICATION RUNNER
// ----------------------------------------------------
async function runCertification(destId = null) {
  switchView('connectors');

  const targetId = destId || document.getElementById('cert-target-dest-select')?.value;
  if (!targetId) {
    showToast('Select a destination to certify', 'error');
    return;
  }

  const fault = document.getElementById('cert-fault-select')?.value || null;
  const logsContainer = document.getElementById('cert-execution-logs');
  logsContainer.innerHTML = '<div style="color:var(--text-muted);">Starting 10-step connector certification run...</div>';

  try {
    const res = await fetch(`${API_BASE}/certification/run/${targetId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': getFreshIdempotencyKey()
      },
      body: JSON.stringify({ fault_injection: fault })
    });

    const report = await res.json();
    logsContainer.innerHTML = '';

    const header = document.createElement('div');
    header.style.marginBottom = '12px';
    header.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h4>Certification Run: <code>${report.run_id}</code></h4>
        <span class="badge ${report.status === 'certified' ? 'badge-certified' : 'badge-failed'}">${report.status.toUpperCase()}</span>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
        Destination: <strong>${report.destination_name}</strong> | Mode: ${report.mode} | Duration: ${report.duration_ms}ms
      </div>
      ${report.evidence_url ? `<div style="margin-top:6px;"><a href="${report.evidence_url}" target="_blank" style="color:var(--accent-teal); font-size:12px;">Download Evidence JSON ↗</a> &nbsp;|&nbsp; <a href="${report.evidence_md_url}" target="_blank" style="color:var(--accent-teal); font-size:12px;">Download Markdown Report ↗</a></div>` : ''}
    `;
    logsContainer.appendChild(header);

    report.steps.forEach(s => {
      const stepRow = document.createElement('div');
      stepRow.className = `rule-item ${s.status === 'passed' ? 'rule-pass' : (s.status === 'skipped' ? 'rule-warn' : 'rule-fail')}`;
      stepRow.innerHTML = `
        <span class="rule-icon">${s.status === 'passed' ? '✓' : (s.status === 'skipped' ? '—' : '✕')}</span>
        <div style="flex:1;">
          <strong>Step ${s.step}: ${s.name}</strong>
          <pre style="font-size:11px; color:var(--text-muted); margin-top:2px;">${JSON.stringify(s.details, null, 2)}</pre>
        </div>
      `;
      logsContainer.appendChild(stepRow);
    });

    showToast(`Certification completed: ${report.status}`, report.status === 'certified' ? 'success' : 'error');
    loadConnectorsView();

  } catch (err) {
    logsContainer.innerHTML = `<div style="color:var(--status-error);">Certification failed: ${err.message}</div>`;
    showToast(err.message, 'error');
  }
}

// ----------------------------------------------------
// 5. CONNECTORS VIEW
// ----------------------------------------------------
async function loadConnectorsView() {
  try {
    const res = await fetch(`${API_BASE}/connectors`);
    const data = await res.json();
    connectorsCache = data.connectors || [];

    const grid = document.getElementById('connectors-grid');
    grid.innerHTML = '';

    connectorsCache.forEach(c => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.marginBottom = '0';
      const isKillSwitch = c.status === 'disabled';

      card.innerHTML = `
        <div class="card-header">
          <span class="card-title">${c.name}</span>
          <span class="badge ${isKillSwitch ? 'badge-failed' : 'badge-certified'}">${c.status.toUpperCase()}</span>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); line-height:1.6;">
          <div>Key: <code>${c.key}</code> (v${c.version})</div>
          <div>Tier: <strong>${c.tier}</strong> | Auth: <strong>${c.auth}</strong></div>
          <div>Capabilities: ${c.capabilities.join(', ')}</div>
        </div>
        <div style="margin-top:14px; display:flex; gap:8px;">
          <button class="btn ${isKillSwitch ? 'btn-primary' : 'btn-danger'} btn-sm" onclick="toggleConnectorKillSwitch('${c.key}')">
            ${isKillSwitch ? 'Deactivate Kill Switch' : 'Activate Kill Switch'}
          </button>
        </div>
      `;
      grid.appendChild(card);
    });

    // Populate certification destination select
    const certSelect = document.getElementById('cert-target-dest-select');
    if (certSelect && destinationsCache.length > 0) {
      certSelect.innerHTML = destinationsCache.slice(0, 30).map(d => `<option value="${d.id}">[${d.platform_key}] ${d.name}</option>`).join('');
    }
  } catch (err) {
    showToast(`Failed loading connectors: ${err.message}`, 'error');
  }
}

async function toggleConnectorKillSwitch(key) {
  try {
    const res = await fetch(`${API_BASE}/connectors/${key}/kill-switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': getFreshIdempotencyKey()
      },
      body: JSON.stringify({})
    });
    const data = await res.json();
    showToast(`Connector '${key}' is now ${data.status}`, 'info');
    loadConnectorsView();
  } catch (err) {
    showToast(`Failed toggling kill switch: ${err.message}`, 'error');
  }
}

// ----------------------------------------------------
// 6. RECOMMENDER VIEW
// ----------------------------------------------------
function setupRecommenderView() {
  document.getElementById('recommender-btn')?.addEventListener('click', async () => {
    const title = document.getElementById('rec-title').value;
    const body = document.getElementById('rec-body').value;
    const isPromo = document.getElementById('rec-is-promo').checked;
    const resultsContainer = document.getElementById('rec-results');

    resultsContainer.innerHTML = '<div style="color:var(--text-muted);">Ranking destination catalogue by audience fit & rule compliance...</div>';

    try {
      const res = await fetch(`${API_BASE}/publish/recommender`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': getFreshIdempotencyKey()
        },
        body: JSON.stringify({
          title,
          body,
          is_promotional: isPromo,
          limit: 10
        })
      });

      const data = await res.json();
      resultsContainer.innerHTML = `
        <div style="margin-bottom:14px; padding:12px; background:var(--bg-surface); border-radius:var(--radius-md);">
          <strong>Top-10 Precision: ${data.precision_top_10 * 100}%</strong>
          <div style="font-size:12px; color:var(--text-muted);">${data.evaluation_notes}</div>
        </div>
      `;

      data.top_recommendations.forEach(r => {
        const item = document.createElement('div');
        item.className = 'rule-item rule-pass';
        item.style.marginBottom = '10px';
        item.innerHTML = `
          <div style="font-size:18px; font-weight:700; color:var(--accent-teal); width:32px;">#${r.rank}</div>
          <div style="flex:1;">
            <div style="display:flex; justify-content:space-between;">
              <strong>${r.name}</strong>
              <span class="badge badge-platform">${r.match_score} pts</span>
            </div>
            <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">Category: ${r.category} | Platform: ${r.platform_key}</div>
            <ul style="font-size:12px; color:var(--text-muted); margin-top:4px; padding-left:16px;">
              ${r.reasons.map(reason => `<li>${reason}</li>`).join('')}
            </ul>
          </div>
        `;
        resultsContainer.appendChild(item);
      });

    } catch (err) {
      resultsContainer.innerHTML = `<div style="color:var(--status-error);">Recommender error: ${err.message}</div>`;
    }
  });
}

// ----------------------------------------------------
// 7. ASSISTED PUBLISHING VIEW
// ----------------------------------------------------
function setupAssistedView() {
  const select = document.getElementById('assisted-dest-select');
  if (select && destinationsCache.length > 0) {
    const assistedDests = destinationsCache.filter(d => d.connector_key === 'assisted' || d.automation_allowed === false);
    select.innerHTML = assistedDests.map(d => `<option value="${d.id}">${d.name} (${d.category || 'Manual Community'})</option>`).join('');
  }

  document.getElementById('assisted-generate-btn')?.addEventListener('click', async () => {
    const destId = document.getElementById('assisted-dest-select').value;
    const title = document.getElementById('assisted-title').value;
    const body = document.getElementById('assisted-body').value;
    const canonical = document.getElementById('assisted-canonical').value;
    const isAi = document.getElementById('assisted-is-ai').checked;
    const resultBox = document.getElementById('assisted-result-box');

    resultBox.innerHTML = '<div style="color:var(--text-muted);">Generating ready-to-post package and operator checklist...</div>';

    try {
      const res = await fetch(`${API_BASE}/assisted/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': getFreshIdempotencyKey()
        },
        body: JSON.stringify({
          destination_id: destId,
          rendition: {
            title,
            body,
            canonical_url: canonical,
            is_ai_generated: isAi
          }
        })
      });

      const pack = await res.json();
      resultBox.innerHTML = `
        <div class="card" style="margin-top:16px;">
          <div class="card-header">
            <span class="card-title">Ready-to-Post Pack: <code>${pack.pack_id}</code></span>
            <a href="${pack.deep_link}" target="_blank" class="btn btn-primary btn-sm">Open Destination Link ↗</a>
          </div>
          <h4>Operator Posting Checklist</h4>
          <div style="margin: 12px 0;">
            ${pack.checklist.map(c => `
              <div class="rule-item rule-pass">
                <span class="rule-icon">☐</span>
                <div><strong>${c.title}</strong>: ${c.detail}</div>
              </div>
            `).join('')}
          </div>
          <h4>Generated Package Downloads</h4>
          <div style="display:flex; gap:12px; margin-top:8px;">
            ${pack.files.map(f => `
              <a href="${f.download_url}" target="_blank" class="btn btn-secondary btn-sm">Download ${f.name}</a>
            `).join('')}
          </div>
        </div>
      `;
    } catch (err) {
      resultBox.innerHTML = `<div style="color:var(--status-error);">Error: ${err.message}</div>`;
    }
  });
}

// ----------------------------------------------------
// 8. AUDIT LOGS VIEW
// ----------------------------------------------------
async function loadAuditLogs() {
  try {
    const res = await fetch(`${API_BASE}/audit/logs?limit=40`);
    const data = await res.json();
    const tbody = document.getElementById('audit-logs-tbody');
    tbody.innerHTML = '';

    if (!data.logs || data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">No audit logs recorded yet.</td></tr>';
      return;
    }

    data.logs.forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="badge badge-platform">${log.event_type}</span></td>
        <td>${log.entity_type || '—'}: ${log.entity_id || '—'}</td>
        <td><code>${log.correlation_id || '—'}</code></td>
        <td><pre style="font-size:11px; max-width:400px; overflow:hidden; text-overflow:ellipsis;">${JSON.stringify(log.payload)}</pre></td>
        <td>${new Date(log.created_at).toLocaleTimeString()}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast(`Failed loading audit logs: ${err.message}`, 'error');
  }
}

// ----------------------------------------------------
// Modals & Initialization
// ----------------------------------------------------
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  // Navigation event listeners
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.getAttribute('data-view');
      switchView(view);
    });
  });

  // Search and filters
  document.getElementById('dest-search-input')?.addEventListener('input', () => loadDestinationsTable(1));
  document.getElementById('dest-platform-filter')?.addEventListener('change', () => loadDestinationsTable(1));
  document.getElementById('dest-status-filter')?.addEventListener('change', () => loadDestinationsTable(1));

  // Workspace buttons and select change
  document.getElementById('workspace-destination-select')?.addEventListener('change', updateWorkspaceModeForDestination);
  document.getElementById('workspace-eval-btn')?.addEventListener('click', evaluateRulesInWorkspace);
  document.getElementById('workspace-tailor-btn')?.addEventListener('click', tailorContentInWorkspace);
  document.getElementById('workspace-publish-btn')?.addEventListener('click', publishFromWorkspace);

  // Add Destination Form
  document.getElementById('add-dest-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value,
      url: form.url.value,
      platform_key: form.platform_key.value,
      category: form.category.value,
      frequency_cap: form.frequency_cap.value || '1/7d',
      self_promo_allowed: form.self_promo_allowed.checked,
      link_policy: form.link_policy.value,
      disclosure_required: form.disclosure_required.checked,
      simulation_mode: true
    };

    try {
      const res = await fetch(`${API_BASE}/destinations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': getFreshIdempotencyKey()
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showToast('Destination created successfully!', 'success');
        closeModal('modal-add-destination');
        form.reset();
        loadDestinationsTable(1);
      } else {
        const err = await res.json();
        showToast(err.error?.message || 'Creation failed', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // CSV Import Form
  document.getElementById('csv-import-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('csv-file-input');
    if (!fileInput.files || fileInput.files.length === 0) {
      showToast('Select a CSV file first', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
      // Send fresh Idempotency-Key; do NOT set Content-Type manually for multipart FormData
      const res = await fetch(`${API_BASE}/destinations/import-csv`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': getFreshIdempotencyKey()
        },
        body: formData
      });
      const data = await res.json();

      if (res.ok) {
        showToast(`Imported ${data.imported_count} destinations (${data.duplicate_count} duplicates skipped)!`, 'success');
        closeModal('modal-import-csv');
        loadDestinationsTable(1);
      } else {
        showToast(data.error?.message || 'CSV Import failed', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Start with overview
  switchView('overview');
});
