import { html, raw } from 'hono/html'
import { claimSetsFor, type Config } from './config.js'
import type { EntraIdentity } from './entra.js'
import { authorizePath } from './util.js'

const styles = `
:root {
  --bg: #dde3ea; --card: #ffffff; --ink: #18212e; --muted: #5a6677; --line: #c6cfda;
  --accent: #1f6f64; --accent-ink: #ffffff; --stripe: #f0c419; --error: #a5281b; --error-bg: #fbe9e6;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121821; --card: #1b2330; --ink: #e6ebf2; --muted: #9aa6b6; --line: #2e3a4b;
    --accent: #4fb3a5; --accent-ink: #0d1a18; --error: #ff9a8a; --error-bg: #3a1d1a;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  background: var(--bg); color: var(--ink);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: grid; place-items: center; padding: 2rem 1rem; min-height: 100vh;
}
.card { width: 100%; max-width: 26rem; background: var(--card); border-radius: 10px; overflow: hidden;
  box-shadow: 0 1px 0 var(--line), 0 12px 32px -18px rgba(24,33,46,.45); }
.tape { background: repeating-linear-gradient(-45deg, var(--stripe) 0 14px, #18212e 14px 28px); height: 12px; }
.tape-note strong { color: var(--ink); font-weight: 600; }
.tape-note { margin: 0; padding: .55rem 1.75rem; font-size: .8125rem; color: var(--muted); border-bottom: 1px solid var(--line); }
.body { padding: 1.5rem 1.75rem 1.75rem; }
h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 .25rem; letter-spacing: -.01em; }
.sub:last-child { margin-bottom: 0; }
.sub { margin: 0 0 1.5rem; color: var(--muted); font-size: .9375rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .875em; }
label { display: block; font-weight: 600; font-size: .875rem; margin: 0 0 1rem; }
input, select { display: block; width: 100%; margin-top: .35rem; padding: .6rem .7rem; font: inherit; font-weight: 400;
  color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; }
.hint { display: block; font-weight: 400; color: var(--muted); font-size: .8125rem; margin-top: .3rem; }
details { margin: -.5rem 0 1rem; font-size: .875rem; }
summary { cursor: pointer; color: var(--accent); width: fit-content; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: .5rem 0 0; padding: .75rem; max-height: 22rem; overflow: auto; border: 1px solid var(--line);
  border-radius: 6px; font: .8125rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
button { width: 100%; margin-top: .5rem; padding: .7rem; font: inherit; font-weight: 600; cursor: pointer;
  color: var(--accent-ink); background: var(--accent); border: 0; border-radius: 6px; }
button:hover { filter: brightness(1.08); }
.error { margin: 0 0 1rem; padding: .6rem .75rem; border-radius: 6px; color: var(--error); background: var(--error-bg); font-size: .9375rem; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; margin-bottom: 1rem; }
th, td { text-align: left; padding: .4rem .25rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
a { color: var(--accent); }
`

const layout = (title: string, note: unknown, body: unknown) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${raw(styles)}</style>
</head>
<body>
<main class="card">
  <div class="tape" aria-hidden="true"></div>
  <p class="tape-note">${note}</p>
  <div class="body">${body}</div>
</main>
</body>
</html>`

export function loginPage(o: {
  cfg: Config
  params: Record<string, string | undefined>
  username: string
  claimSet?: string
  error?: string
  /** Set when the Entra gate is on: replaces the password field. */
  entra?: EntraIdentity
}) {
  const claimSets = claimSetsFor(o.cfg, o.params.scope)
  const sets = claimSets.map((name) => [name, o.cfg.claimSets[name]] as const)
  const selected = o.claimSet && claimSets.includes(o.claimSet) ? o.claimSet : claimSets[0]
  const descriptions = JSON.stringify(Object.fromEntries(sets.map(([n, s]) => [n, s.description ?? '']))).replace(/</g, '\\u003c')
  const clientName = o.cfg.clients.find((cl) => cl.clientId === o.params.client_id)?.name
  const hidden = Object.entries(o.params).filter(([, v]) => v !== undefined)
  const switchUrl = `/entra/switch?return=${encodeURIComponent(authorizePath(o.params))}`
  const note = o.entra
    ? html`Verified with Microsoft Entra as <strong>${o.entra.name || o.entra.username}</strong>${o.entra.name && o.entra.username ? html` (${o.entra.username})` : ''}. <a href="${switchUrl}">Switch account</a>`
    : 'Test identity provider. Any username works; use one of the shared passwords.'

  return layout('Sign in – faux-idc', note, html`
    <h1>Sign in</h1>
    <p class="sub">Continue to ${clientName ? html`<strong>${clientName}</strong>` : html`<code>${o.params.client_id}</code>`}</p>
    ${o.error ? html`<p class="error" role="alert">${o.error}</p>` : ''}
    <form method="post" action="/authorize">
      ${hidden.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <label>Username
        <input name="username" value="${o.username}" required autocomplete="username" ${o.username ? '' : raw('autofocus')}>
        <span class="hint">Becomes the <code>sub</code> and <code>preferred_username</code> unless the claim set overrides them.</span>
      </label>
      <label>Claim set
        <select name="claim_set" id="claim_set">
          ${sets.map(([n]) => html`<option value="${n}" ${n === selected ? raw('selected') : ''}>${n}</option>`)}
        </select>
        <span class="hint" id="set_description">${o.cfg.claimSets[selected].description ?? ''}</span>
      </label>
      <details>
        <summary>Preview token claims</summary>
        <pre id="preview"></pre>
      </details>
      ${o.entra ? '' : html`<label>Password
        <input type="password" name="password" required autocomplete="current-password" ${o.username ? raw('autofocus') : ''}>
      </label>`}
      <button type="submit" ${o.entra && o.username ? raw('autofocus') : ''}>${o.entra ? 'Continue as this user' : 'Sign in'}</button>
    </form>
    <script>
      (function () {
        var descriptions = ${raw(descriptions)};
        var sel = document.getElementById('claim_set');
        var user = document.querySelector('input[name=username]');
        var out = document.getElementById('preview');
        var desc = document.getElementById('set_description');
        var timer, seq = 0;
        function render() {
          desc.textContent = descriptions[sel.value] || '';
          clearTimeout(timer);
          timer = setTimeout(function () {
            var mine = ++seq;
            fetch('/claims-preview?claim_set=' + encodeURIComponent(sel.value) + '&username=' + encodeURIComponent(user.value))
              .then(function (r) { return r.json(); })
              .then(function (claims) { if (mine === seq) out.textContent = JSON.stringify(claims, null, 2); })
              .catch(function () { out.textContent = 'Preview unavailable.'; });
          }, 150);
        }
        sel.addEventListener('change', render);
        user.addEventListener('input', render);
        render();
      })();
    </script>`)
}

export function messagePage(title: string, message: string) {
  return layout(`${title} – faux-idc`, 'Test identity provider.', html`
    <h1>${title}</h1>
    <p class="sub">${message}</p>`)
}

export function homePage(cfg: Config, issuer: string) {
  return layout('faux-idc', 'Test identity provider. Not for production use.', html`
    <h1>faux-idc is running</h1>
    <p class="sub">Point your app at <a href="${issuer}/.well-known/openid-configuration"><code>${issuer}</code></a></p>
    <table>
      <tr><th>Claim set</th><th>Description</th><th>Scopes</th></tr>
      ${Object.entries(cfg.claimSets).map(([n, s]) => html`<tr><td><code>${n}</code></td><td>${s.description ?? ''}</td><td>${s.scopes.map((sc) => html`<code>${sc}</code> `)}</td></tr>`)}
    </table>
    <table>
      <tr><th>Clients</th><th>Owned scopes</th></tr>
      ${cfg.clients.length
        ? cfg.clients.map((cl) => html`<tr><td>${cl.name ? html`${cl.name}<br>` : ''}<code>${cl.clientId}</code>${cl.clientSecret ? ' (confidential)' : ' (public)'}</td><td>${cl.scopes.map((sc) => html`<code>${sc}</code> `)}</td></tr>`)
        : html`<tr><td colspan="2">Any client_id and redirect_uri is accepted.</td></tr>`}
    </table>`)
}
