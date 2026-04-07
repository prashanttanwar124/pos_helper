const helperStatusEl = document.getElementById('helperStatus');
const readerStatusEl = document.getElementById('readerStatus');
const lastUidEl = document.getElementById('lastUid');
const pendingStatusEl = document.getElementById('pendingStatus');
const lastErrorEl = document.getElementById('lastError');
const recentActionsEl = document.getElementById('recentActions');

const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const refreshButton = document.getElementById('refreshButton');
const logsButton = document.getElementById('logsButton');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderActions(actions) {
  if (!actions || actions.length === 0) {
    recentActionsEl.innerHTML = '<p class="empty-state">No activity yet.</p>';
    return;
  }

  recentActionsEl.innerHTML = actions
    .map((action) => {
      const details = action.details
        ? `<pre>${escapeHtml(JSON.stringify(action.details, null, 2))}</pre>`
        : '';

      return `
        <article class="activity-item">
          <div class="activity-top">
            <span class="badge">${escapeHtml(action.type)}</span>
            <time>${escapeHtml(action.timestamp)}</time>
          </div>
          <p>${escapeHtml(action.message)}</p>
          ${details}
        </article>
      `;
    })
    .join('');
}

function applyStatus(status) {
  helperStatusEl.textContent = status.running ? 'Running' : 'Stopped';
  readerStatusEl.textContent = status.reader_connected
    ? `Connected: ${status.reader_name || 'Reader detected'}`
    : 'Not connected';
  lastUidEl.textContent = status.last_seen_uid || '-';
  pendingStatusEl.textContent = status.pending_operation
    ? status.pending_operation.type
    : 'None';
  lastErrorEl.textContent = status.last_error || 'No recent errors.';
  renderActions(status.recent_actions || []);
}

async function refreshStatus() {
  const status = await window.nfcDesktop.getStatus();
  applyStatus(status);
}

async function runAction(fn) {
  startButton.disabled = true;
  stopButton.disabled = true;
  refreshButton.disabled = true;

  try {
    const status = await fn();
    applyStatus(status);
  } finally {
    startButton.disabled = false;
    stopButton.disabled = false;
    refreshButton.disabled = false;
  }
}

startButton.addEventListener('click', () => {
  runAction(() => window.nfcDesktop.startHelper());
});

stopButton.addEventListener('click', () => {
  runAction(() => window.nfcDesktop.stopHelper());
});

refreshButton.addEventListener('click', () => {
  refreshStatus();
});

logsButton.addEventListener('click', () => {
  window.nfcDesktop.openLogs();
});

refreshStatus();
setInterval(refreshStatus, 4000);
