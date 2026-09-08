const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-cohub-startup'">
<title>Cohub Dev2</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; background: #f8f8fa; letter-spacing: 0; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
header { display: flex; gap: 16px; align-items: baseline; padding: 24px 32px; border-bottom: 1px solid #dedee3; }
header strong { font-size: 18px; } header span { font-size: 13px; color: #60616b; }
main { flex: 1; width: min(100%, 720px); margin: auto; padding: 72px 32px; }
.state { font-size: 13px; color: #3f6653; margin-bottom: 14px; }
h1 { font-size: 24px; font-weight: 600; margin: 0 0 16px; line-height: 1.35; overflow-wrap: anywhere; }
#detail { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; color: #51525e; min-height: 48px; margin: 0 0 28px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
button { min-height: 38px; padding: 8px 14px; border: 1px solid #c4c5cd; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
button:hover { background: #e9e9ee; } button:active { background: #dddde4; }
button:focus-visible { outline: 2px solid #27754d; outline-offset: 3px; }
button:disabled { opacity: .55; cursor: default; }
#retry { background: #202124; color: #fff; border-color: #202124; } #retry:hover { background: #393a40; }
#action-error { color: #ac2636; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
footer { color: #60616b; padding: 20px 32px; font-size: 12px; }
@media (prefers-color-scheme: dark) {
 :root { color: #f1f1f3; background: #1d1e22; } header { border-color: #393a42; }
 header span, footer, #detail { color: #b9bac4; } .state { color: #91c6a8; }
 button { border-color: #666772; } button:hover { background: #313239; } button:active { background: #44454e; }
 #retry { color: #202124; background: #e9e9ee; border-color: #e9e9ee; } #retry:hover { background: #fff; }
 #action-error { color: #ffacb5; }
}
</style>
</head>
<body>
<header><strong>Cohub</strong><span>Dev2 / Local</span></header>
<main>
<div class="state">Local services</div>
<section role="status" aria-live="polite" aria-atomic="true">
<h1 id="status">Starting local services</h1><p id="detail"></p>
</section>
<div class="actions"><button id="retry" disabled>Retry</button><button id="diagnostics">View Diagnostics</button><button id="quit">Quit Cohub</button></div>
<p id="action-error" role="alert"></p>
</main>
<footer>Cohub Dev2</footer>
<script nonce="cohub-startup">
const bridge = window.cohubDesktop;
const title = document.getElementById('status');
const detail = document.getElementById('detail');
const retry = document.getElementById('retry');
let retrying = false;
let lastStatus = null;
function render(status) {
 lastStatus = status;
 const labels = { initializing: 'Starting local services', recovering: 'Recovering local services', connecting: 'Opening local workspace', connected: 'Opening local workspace', 'signed-out': 'Starting local workspace', 'local-runtime-unavailable': 'Local services unavailable', error: 'Local services need attention', stopped: 'Cohub stopped' };
 title.textContent = labels[status.state] || 'Local services need attention';
 detail.textContent = status.message || '';
 if (status.state === 'recovering' && status.attempt) title.textContent += ' (' + status.attempt + '/' + status.maxAttempts + ')';
 retry.disabled = retrying || !['error', 'local-runtime-unavailable', 'stopped'].includes(status.state);
}
async function action(button, operation) {
 document.getElementById('action-error').textContent = '';
 button.disabled = true;
 try { await operation(); }
 catch (error) { document.getElementById('action-error').textContent = error.message || String(error); }
 finally { button.disabled = false; }
}
let receivedStatus = false;
bridge.onStatus((status) => { receivedStatus = true; render(status); });
bridge.getStatus().then((status) => { if (!receivedStatus) render(status); }).catch((error) => { document.getElementById('action-error').textContent = error.message; });
retry.addEventListener('click', async () => {
 retrying = true;
 await action(retry, () => bridge.retry());
 retrying = false;
 if (lastStatus) render(lastStatus);
});
document.getElementById('diagnostics').addEventListener('click', (event) => action(event.currentTarget, () => bridge.diagnostics()));
document.getElementById('quit').addEventListener('click', (event) => action(event.currentTarget, () => bridge.quit()));
</script>
</body></html>`;

export const startupPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
