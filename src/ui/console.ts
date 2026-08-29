import type { Env } from '../env';

/**
 * The operator console. One self-contained page, no build step, no CDN.
 *
 * It is deliberately plain. The point of this screen is the approvals queue:
 * an operator should be able to read what an agent wants to do, see the
 * editorial score behind it, and say yes or no in one click.
 */
export function renderConsole(env: Env): string {
  const business = escapeHtml(env.BBA_BUSINESS_NAME ?? 'BBA Network');
  const environment = escapeHtml(env.BBA_ENV ?? 'development');
  return PAGE.replace(/__BUSINESS__/g, business).replace(/__ENV__/g, environment);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>__BUSINESS__ Growth OS</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #14181d; --line: #232a32; --text: #e7ecf2;
    --muted: #9aa7b4; --gold: #d4af37; --ok: #4ea87a; --warn: #d8a13a; --bad: #d15b52;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 14px; padding: 18px 22px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5;
  }
  header h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .mark { width: 32px; height: 32px; border-radius: 8px; background: var(--gold); color: #0b0d10;
          display: grid; place-items: center; font-weight: 700; font-size: 13px; letter-spacing: .5px; }
  .tag { font-size: 12px; color: var(--muted); border: 1px solid var(--line); padding: 2px 8px; border-radius: 999px; }
  main { padding: 22px; max-width: 1180px; margin: 0 auto; }
  nav { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 20px; }
  nav button {
    background: var(--panel); color: var(--muted); border: 1px solid var(--line);
    padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 14px;
  }
  nav button[aria-selected="true"] { color: var(--text); border-color: var(--gold); }
  section { display: none; }
  section[data-active] { display: block; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .stat .value { font-size: 26px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; color: var(--muted); }
  button.action { border: 1px solid var(--line); background: transparent; color: var(--text);
                  padding: 6px 12px; border-radius: 7px; cursor: pointer; font-size: 13px; }
  button.action:hover { border-color: var(--gold); }
  button.approve { border-color: var(--ok); color: var(--ok); }
  button.reject { border-color: var(--bad); color: var(--bad); }
  input, textarea {
    background: #0f1317; color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 8px 10px; font: inherit; width: 100%;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .pill.high { border-color: var(--bad); color: var(--bad); }
  .pill.ok { border-color: var(--ok); color: var(--ok); }
  .pill.warn { border-color: var(--warn); color: var(--warn); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 20px 0; text-align: center; }
  #toast { position: fixed; bottom: 18px; right: 18px; background: var(--panel);
           border: 1px solid var(--gold); padding: 10px 14px; border-radius: 9px; display: none; }
</style>
</head>
<body>
<header>
  <div class="mark">BBA</div>
  <h1>__BUSINESS__ Growth OS</h1>
  <span class="tag">__ENV__</span>
  <span class="tag" id="mode">checking</span>
  <div style="margin-left:auto" class="row">
    <input id="token" type="password" placeholder="admin token" style="width:220px">
    <button class="action" id="save-token">Connect</button>
  </div>
</header>

<main>
  <nav>
    <button data-tab="overview" aria-selected="true">Overview</button>
    <button data-tab="approvals">Approvals</button>
    <button data-tab="performance">Performance</button>
    <button data-tab="content">Content</button>
    <button data-tab="decisions">Decisions</button>
    <button data-tab="accounts">Accounts</button>
  </nav>

  <section data-tab="overview" data-active>
    <div class="grid" id="stats"></div>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>Controls</strong>
        <div class="row">
          <button class="action" id="run-sweep">Run a full cycle now</button>
          <button class="action" id="toggle-pause">Pause</button>
          <button class="action" id="toggle-dry">Toggle dry run</button>
        </div>
      </div>
      <pre id="config"></pre>
    </div>
    <div class="card">
      <strong>Today's note</strong>
      <div id="report" class="muted">Nothing written yet.</div>
    </div>
    <div class="card">
      <strong>Open incidents</strong>
      <div id="incidents"></div>
    </div>
  </section>

  <section data-tab="approvals">
    <div class="card">
      <strong>Waiting on you</strong>
      <p class="muted" style="margin:6px 0 0">
        Nothing here has been published or spent. Approving is what makes it real.
      </p>
    </div>
    <div id="approvals"></div>
  </section>

  <section data-tab="performance">
    <div class="grid" id="perf-stats"></div>
    <div class="card"><table id="perf-table"></table></div>
  </section>

  <section data-tab="content">
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>Creative</strong>
        <div class="row">
          <button class="action" data-draft="organic_post">Draft organic copy</button>
          <button class="action" data-tab-jump="approvals">Review queue</button>
        </div>
      </div>
    </div>
    <div class="card"><table id="creatives-table"></table></div>
    <div class="card"><strong>Scheduled posts</strong><table id="posts-table"></table></div>
  </section>

  <section data-tab="decisions">
    <div class="card"><table id="decisions-table"></table></div>
  </section>

  <section data-tab="accounts">
    <div class="card"><table id="accounts-table"></table></div>
    <div class="card">
      <strong>Connect an account</strong>
      <p class="muted" style="margin:4px 0 12px">
        Put the credential in a Worker secret first, then name that secret here.
        The token itself is never stored in the database.
      </p>
      <div class="grid">
        <input id="acc-channel" placeholder="channel (tiktok, instagram, ...)">
        <input id="acc-surface" placeholder="surface (organic or ads)">
        <input id="acc-external" placeholder="external id">
        <input id="acc-secret" placeholder="secret name (TIKTOK_ACCESS_TOKEN)">
        <input id="acc-handle" placeholder="handle (optional)">
        <button class="action" id="acc-save">Connect</button>
      </div>
    </div>
  </section>
</main>

<div id="toast"></div>

<script>
const state = { token: localStorage.getItem('bba_admin') || '' };
document.getElementById('token').value = state.token;

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + state.token,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) { toast('Token rejected'); throw new Error('unauthorized'); }
  return res.json();
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);

document.getElementById('save-token').onclick = () => {
  state.token = document.getElementById('token').value.trim();
  localStorage.setItem('bba_admin', state.token);
  refresh();
};

document.querySelectorAll('nav button').forEach((button) => {
  button.onclick = () => selectTab(button.dataset.tab);
});
document.querySelectorAll('[data-tab-jump]').forEach((button) => {
  button.onclick = () => selectTab(button.dataset.tabJump);
});
function selectTab(name) {
  document.querySelectorAll('nav button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('section').forEach((s) =>
    s.dataset.tab === name ? s.setAttribute('data-active', '') : s.removeAttribute('data-active'));
}

async function refresh() {
  if (!state.token) { toast('Enter the admin token'); return; }
  try {
    const status = await api('/api/status');
    renderStatus(status);
    await Promise.all([
      loadApprovals(), loadPerformance(), loadContent(), loadDecisions(),
      loadAccounts(status), loadReport(), loadIncidents(),
    ]);
  } catch (err) { /* toast already shown */ }
}

function renderStatus(status) {
  const config = status.config || {};
  document.getElementById('mode').textContent =
    (config.paused ? 'paused' : config.dryRun ? 'dry run' : 'live') +
    (config.requireHumanApproval ? ' / approval required' : ' / auto-approve');
  document.getElementById('config').textContent = JSON.stringify(config, null, 2);
  document.getElementById('toggle-pause').textContent = config.paused ? 'Resume' : 'Pause';

  const missing = Object.entries(status.secrets || {}).filter(([, v]) => !v).map(([k]) => k);
  document.getElementById('stats').innerHTML = [
    stat('Spend today', money(status.spend_today_cents)),
    stat('Waiting on you', status.pending_approvals),
    stat('Open incidents', status.open_incidents),
    stat('Accounts', (status.accounts || []).length),
    stat('Missing secrets', missing.length ? missing.join(', ') : 'none'),
  ].join('');
}
function stat(label, value) {
  return '<div class="card stat"><div class="label">' + esc(label) +
         '</div><div class="value">' + esc(value) + '</div></div>';
}

async function loadIncidents() {
  const { incidents = [] } = await api('/api/incidents');
  document.getElementById('incidents').innerHTML = incidents.length
    ? '<table>' + incidents.map((i) =>
        '<tr><td><span class="pill ' + (i.severity === 'critical' || i.severity === 'error' ? 'high' : 'warn') +
        '">' + esc(i.severity) + '</span></td><td>' + esc(i.code) + '</td><td>' + esc(i.message) +
        '</td><td><button class="action" onclick="resolveIncident(\'' + esc(i.id) +
        '\')">Resolve</button></td></tr>').join('') + '</table>'
    : '<div class="empty">Nothing open.</div>';
}
window.resolveIncident = async (incidentId) => {
  await api('/api/incidents/' + incidentId + '/resolve', { method: 'POST' });
  loadIncidents();
};

async function loadReport() {
  const { report } = await api('/api/report');
  document.getElementById('report').textContent =
    report && report.narrative ? report.narrative : 'Nothing written yet.';
}

async function loadApprovals() {
  const { approvals = [] } = await api('/api/approvals');
  const host = document.getElementById('approvals');
  if (!approvals.length) { host.innerHTML = '<div class="card empty">Nothing waiting.</div>'; return; }

  host.innerHTML = approvals.map((a) => {
    const subject = a.subject || {};
    const score = subject.editorial_score;
    const findings = subject.editorial_report
      ? (JSON.parse(subject.editorial_report).findings || []).slice(0, 4)
      : [];
    return '<div class="card">' +
      '<div class="row" style="justify-content:space-between">' +
        '<div class="row">' +
          '<span class="pill ' + (a.risk === 'high' ? 'high' : '') + '">' + esc(a.risk) + '</span>' +
          '<span class="pill">' + esc(a.subject_type) + '</span>' +
          (a.channel ? '<span class="pill">' + esc(a.channel) + '</span>' : '') +
          (score != null ? '<span class="pill ' + (score >= 78 ? 'ok' : 'warn') + '">score ' + esc(score) + '</span>' : '') +
        '</div>' +
        '<div class="row">' +
          '<button class="action approve" onclick="decide(\'' + esc(a.id) + '\',\'approve\')">Approve</button>' +
          '<button class="action reject" onclick="decide(\'' + esc(a.id) + '\',\'reject\')">Reject</button>' +
        '</div>' +
      '</div>' +
      '<p style="margin:10px 0 4px"><strong>' + esc(a.summary) + '</strong></p>' +
      (a.rationale ? '<p class="muted" style="margin:0">' + esc(a.rationale) + '</p>' : '') +
      (subject.hook || subject.body
        ? '<pre style="color:var(--text)">' + esc([subject.hook, subject.body, subject.cta].filter(Boolean).join('\n\n')) + '</pre>'
        : '') +
      (findings.length
        ? '<p class="muted" style="margin:8px 0 0">Editorial notes: ' +
          findings.map((f) => esc(f.label)).join('; ') + '</p>'
        : '') +
      (a.proposed && a.proposed !== '{}' ? '<pre>' + esc(a.proposed) + '</pre>' : '') +
    '</div>';
  }).join('');
}

window.decide = async (approvalId, decision) => {
  const result = await api('/api/approvals/' + approvalId, {
    method: 'POST',
    body: JSON.stringify({ decision, decidedBy: 'console' }),
  });
  toast(result.message || 'done');
  refresh();
};

async function loadPerformance() {
  const data = await api('/api/performance?days=14');
  document.getElementById('perf-stats').innerHTML = [
    stat('Blended ROAS', (data.blended_roas || 0).toFixed(2)),
    stat('Blended CAC', data.blended_cac_cents ? money(data.blended_cac_cents) : 'no conversions yet'),
    stat('Channels', (data.performances || []).length),
  ].join('');

  const rows = data.performances || [];
  document.getElementById('perf-table').innerHTML =
    '<tr><th>Channel</th><th>Spend</th><th>Revenue</th><th>Conversions</th><th>ROAS</th><th>Daily budget</th><th>Days</th></tr>' +
    (rows.length
      ? rows.map((p) =>
          '<tr><td>' + esc(p.channel) + '</td><td>' + money(p.spendCents) + '</td><td>' +
          money(p.revenueCents) + '</td><td>' + esc(p.conversions) + '</td><td>' +
          (p.spendCents > 0 ? (p.revenueCents / p.spendCents).toFixed(2) : '-') + '</td><td>' +
          money(p.currentDailyBudgetCents) + '</td><td>' + esc(p.daysActive) + '</td></tr>').join('')
      : '<tr><td colspan="7" class="empty">No spend recorded yet.</td></tr>');
}

async function loadContent() {
  const { creatives = [] } = await api('/api/creatives');
  document.getElementById('creatives-table').innerHTML =
    '<tr><th>Channel</th><th>Status</th><th>Score</th><th>Hook</th><th>Created</th></tr>' +
    (creatives.length
      ? creatives.slice(0, 40).map((c) =>
          '<tr><td>' + esc(c.channel) + '</td><td><span class="pill ' +
          (c.status === 'approved' || c.status === 'live' ? 'ok' : c.status === 'rejected' ? 'high' : 'warn') +
          '">' + esc(c.status) + '</span></td><td>' + esc(c.editorial_score ?? '-') + '</td><td>' +
          esc((c.hook || c.body || '').slice(0, 90)) + '</td><td class="muted">' +
          esc((c.created_at || '').slice(0, 16)) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="empty">No copy drafted yet.</td></tr>');

  const { posts = [] } = await api('/api/posts');
  document.getElementById('posts-table').innerHTML =
    '<tr><th>Channel</th><th>Status</th><th>Scheduled</th><th>Link</th></tr>' +
    (posts.length
      ? posts.slice(0, 30).map((p) =>
          '<tr><td>' + esc(p.channel) + '</td><td>' +
          (p.status === 'needs_reconcile'
            ? '<span class="pill high">check the account</span>'
            : esc(p.status)) +
          '</td><td class="muted">' +
          esc((p.scheduled_for || '').slice(0, 16)) + '</td><td>' +
          (p.status === 'needs_reconcile'
            // The platform never answered, so only a person looking at the
            // account can say which of these it was.
            ? '<button class="action" onclick="resolvePost(\'' + esc(p.id) +
                '\',\'published\')">It posted</button> ' +
              '<button class="action" onclick="resolvePost(\'' + esc(p.id) +
                '\',\'cancelled\')">It did not</button>'
            : p.permalink
              ? '<a href="' + esc(p.permalink) + '" target="_blank" rel="noopener">open</a>'
              : '-') +
          '</td></tr>').join('')
      : '<tr><td colspan="4" class="empty">Nothing scheduled.</td></tr>');
}

/** Answer a held post: did it actually go out or not? */
async function resolvePost(postId, outcome) {
  const permalink =
    outcome === 'published'
      ? prompt('Paste the link to the post, if you have it. Leave blank to skip.') || ''
      : '';
  const res = await api('/api/posts/' + postId + '/resolve', {
    method: 'POST',
    body: JSON.stringify({ outcome, ...(permalink ? { permalink } : {}) }),
  });
  toast(res.warning || (outcome === 'published' ? 'Marked as posted' : 'Marked as not posted'));
  await loadPosts();
  await loadIncidents();
}

async function loadDecisions() {
  const { decisions = [] } = await api('/api/decisions?days=7');
  document.getElementById('decisions-table').innerHTML =
    '<tr><th>When</th><th>Agent</th><th>Action</th><th>Outcome</th><th>Why</th></tr>' +
    (decisions.length
      ? decisions.slice(0, 60).map((d) =>
          '<tr><td class="muted">' + esc((d.created_at || '').slice(5, 16)) + '</td><td>' +
          esc(d.agent) + '</td><td>' + esc(d.action) + '</td><td><span class="pill ' +
          (d.outcome === 'applied' ? 'ok' : d.outcome === 'failed' ? 'high' : '') + '">' +
          esc(d.outcome) + '</span></td><td>' + esc((d.rationale || '').slice(0, 140)) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="empty">No decisions recorded yet.</td></tr>');
}

async function loadAccounts(status) {
  const { accounts = [] } = await api('/api/accounts');
  document.getElementById('accounts-table').innerHTML =
    '<tr><th>Channel</th><th>Surface</th><th>Handle</th><th>Status</th><th>Secret</th></tr>' +
    (accounts.length
      ? accounts.map((a) =>
          '<tr><td>' + esc(a.channel) + '</td><td>' + esc(a.surface) + '</td><td>' +
          esc(a.handle || '-') + '</td><td><span class="pill ' +
          (a.status === 'active' ? 'ok' : 'high') + '">' + esc(a.status) + '</span></td><td><code>' +
          esc(a.secret_ref) + '</code></td></tr>').join('')
      : '<tr><td colspan="5" class="empty">Nothing connected yet.</td></tr>');
}

document.getElementById('acc-save').onclick = async () => {
  const result = await api('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({
      channel: document.getElementById('acc-channel').value.trim(),
      surface: document.getElementById('acc-surface').value.trim() || 'organic',
      externalId: document.getElementById('acc-external').value.trim(),
      secretRef: document.getElementById('acc-secret').value.trim(),
      handle: document.getElementById('acc-handle').value.trim() || null,
    }),
  });
  toast(result.error ? result.message || result.error : 'connected');
  refresh();
};

document.getElementById('run-sweep').onclick = async () => {
  const result = await api('/api/run', { method: 'POST' });
  toast('queued ' + result.enqueued + ' jobs');
  setTimeout(refresh, 2500);
};

document.getElementById('toggle-pause').onclick = async () => {
  const config = await api('/api/config');
  const next = await api('/api/config', {
    method: 'POST', body: JSON.stringify({ paused: !config.paused }),
  });
  toast(next.paused ? 'paused' : 'resumed');
  refresh();
};

document.getElementById('toggle-dry').onclick = async () => {
  const config = await api('/api/config');
  const next = await api('/api/config', {
    method: 'POST', body: JSON.stringify({ dryRun: !config.dryRun }),
  });
  toast(next.dryRun ? 'dry run on' : 'dry run OFF, actions are live');
  refresh();
};

document.querySelectorAll('[data-draft]').forEach((button) => {
  button.onclick = async () => {
    const result = await api('/api/agents/creative/draft_batch', {
      method: 'POST',
      body: JSON.stringify({ kind: button.dataset.draft, count: 2 }),
    });
    toast(result.summary || 'done');
    refresh();
  };
});

if (state.token) refresh();
</script>
</body>
</html>`;
