import { html, raw } from 'hono/html'
import pkg from '../package.json' with { type: 'json' }
import { visibleClaimSets, type Config } from './config.js'
import type { EntraIdentity } from './entra.js'
import { authorizePath } from './util.js'

const VERSION = pkg.version
const DOCS_URL = 'https://github.com/domibies/faux-idc#readme'
/** With more claim sets than this, the sign-in form shows a dropdown instead of radio cards. */
const MAX_CARDS = 5

const styles = `
:root {
  --bg: #f4f5f7; --card: #ffffff; --ink: #0f172a; --ink-2: #334155; --muted: #64748b; --line: #e2e8f0; --line-strong: #cbd5e1;
  --field: #ffffff; --soft: #f8fafc;
  --accent: #0f766e; --accent-hover: #115e59; --accent-ink: #ffffff; --accent-soft: #f0fdfa; --accent-line: #5eead4;
  --test: #92400e; --test-bg: #fef3c7; --test-line: #fcd34d;
  --ok: #15803d; --error: #b91c1c; --error-bg: #fef2f2; --error-line: #fecaca;
  --code-key: #0f766e; --code-str: #9a3412; --code-lit: #6d28d9;
  --shadow: 0 1px 2px rgba(15,23,42,.06), 0 8px 24px -12px rgba(15,23,42,.18);
  --radius: 12px; --radius-sm: 8px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f14; --card: #121821; --ink: #e6ebf2; --ink-2: #c3ccd8; --muted: #8b96a6; --line: #1f2935; --line-strong: #2c3846;
    --field: #0e141b; --soft: #0f151d;
    --accent: #2bb3a3; --accent-hover: #46c7b8; --accent-ink: #04201d; --accent-soft: rgba(43,179,163,.1); --accent-line: #1f7f75;
    --test: #fcd34d; --test-bg: rgba(252,211,77,.12); --test-line: rgba(252,211,77,.35);
    --ok: #4ade80; --error: #fca5a5; --error-bg: rgba(248,113,113,.1); --error-line: rgba(248,113,113,.3);
    --code-key: #5eead4; --code-str: #fdba74; --code-lit: #c4b5fd;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 32px -16px rgba(0,0,0,.6);
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body {
  min-height: 100vh; padding: 32px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
body.top { justify-content: flex-start; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.page { width: 400px; max-width: 100%; }
.page.wide { width: 880px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); }
.card-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--line); }
.card-body { padding: 24px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }
.mark { width: 24px; height: 24px; flex: none; }
.mark-bg { fill: var(--accent); }
.mark-fg { fill: none; stroke: var(--accent-ink); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.badge { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--test); background: var(--test-bg); border: 1px solid var(--test-line); }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.chip { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-family: var(--mono);
  font-size: 11.5px; color: var(--ink-2); background: var(--soft); border: 1px solid var(--line); white-space: nowrap; }
.foot { margin: 16px 0 0; text-align: center; font-size: 12px; color: var(--muted); }

h1 { font-size: 20px; font-weight: 600; letter-spacing: -.015em; line-height: 1.3; margin: 0; }
.subtitle { margin: 4px 0 24px; color: var(--muted); }
.subtitle:last-child { margin-bottom: 0; }
.subtitle strong { color: var(--ink); font-weight: 600; }
.error { margin: 0 0 16px; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 13px;
  color: var(--error); background: var(--error-bg); border: 1px solid var(--error-line); }

.field { margin: 0 0 16px; }
.label { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 13px; font-weight: 500; }
.aside { font-weight: 400; font-size: 12px; color: var(--muted); }
.input { display: block; width: 100%; height: 40px; padding: 0 12px; font: inherit; color: var(--ink); background: var(--field);
  border: 1px solid var(--line-strong); border-radius: var(--radius-sm); transition: border-color .15s, box-shadow .15s; }
.input:hover { border-color: var(--muted); }
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
select.input { appearance: none; padding-right: 36px; cursor: pointer;
  background: var(--field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%2364748b' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center / 14px; }
.help { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
#sets:not([hidden]) ~ #set_description { display: none; }

.sets { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.set { position: relative; display: grid; grid-template-columns: 16px 1fr; gap: 10px; align-items: start; padding: 10px 12px;
  border: 1px solid var(--line-strong); border-radius: var(--radius-sm); cursor: pointer; transition: border-color .15s, background .15s; }
.set:hover { border-color: var(--muted); }
.set input { position: absolute; opacity: 0; pointer-events: none; }
.dot { width: 16px; height: 16px; margin-top: 2px; border-radius: 50%; border: 1.5px solid var(--line-strong); background: var(--field); }
.set:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.set:has(input:checked) .dot { border: 5px solid var(--accent); }
.set:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.set .name { display: block; font-family: var(--mono); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.set .desc { display: block; font-size: 12.5px; color: var(--muted); }

.claims { margin: 0 0 16px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--soft); overflow: hidden; }
.claims summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 13px; font-weight: 500; }
.claims summary::-webkit-details-marker { display: none; }
.chev { width: 14px; height: 14px; color: var(--muted); transition: transform .15s; }
.claims[open] .chev { transform: rotate(90deg); }
.count { color: var(--muted); font-weight: 400; }
.claims summary .copy { margin-left: auto; }
.json { margin: 0; padding: 10px 12px; border-top: 1px solid var(--line); font: 11.5px/1.6 var(--mono); white-space: pre;
  overflow: auto; max-height: 240px; color: var(--ink-2); }
.json .k { color: var(--code-key); } .json .s { color: var(--code-str); } .json .l { color: var(--code-lit); }

.btn { width: 100%; height: 40px; font: inherit; font-weight: 500; color: var(--accent-ink); background: var(--accent);
  border: 0; border-radius: var(--radius-sm); cursor: pointer; transition: background .15s; }
.btn:hover { background: var(--accent-hover); }
.copy { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; flex: none; font: inherit; font-size: 12px;
  color: var(--muted); background: transparent; border: 1px solid var(--line-strong); border-radius: 6px; cursor: pointer; }
.copy:hover { color: var(--ink); border-color: var(--muted); }
.copy.copied { color: var(--accent); border-color: var(--accent); }
.copy svg { width: 12px; height: 12px; }

.identity { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: 0 0 16px;
  border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--soft); }
.avatar { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center;
  font-size: 12px; font-weight: 600; color: var(--accent-ink); background: var(--accent); }
.who { min-width: 0; line-height: 1.35; }
.who strong { display: block; font-weight: 500; }
.who span { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.identity a { margin-left: auto; font-size: 12.5px; white-space: nowrap; }

.topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 24px; }
.ver { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.topbar nav { margin-left: auto; display: flex; gap: 16px; font-size: 13px; }
.topbar nav a { color: var(--muted); }
.hero { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; padding: 20px 24px; margin-bottom: 16px; }
.status { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; font-size: 16px; }
.status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent); }
.issuer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; margin-left: auto; color: var(--muted); }
.issuer code { color: var(--ink); font-size: 13px; overflow-wrap: anywhere; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.grid .span { grid-column: 1 / -1; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--line); }
.panel-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.panel-head span { font-size: 12px; color: var(--muted); }
.rows { margin: 0; padding: 0; list-style: none; }
.rows li { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-top: 1px solid var(--line); min-width: 0; }
.rows li:first-child { border-top: 0; }
.rows .lbl { width: 92px; flex: none; color: var(--muted); font-size: 13px; }
.rows .val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows .main { flex: 1; min-width: 0; }
.rows .main code { white-space: nowrap; }
.rows .main small { display: block; color: var(--muted); font-size: 12.5px; }
.rows .tags { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.type { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; flex: none; font-size: 11.5px;
  color: var(--muted); border: 1px solid var(--line-strong); border-radius: 999px; }
.type.conf { color: var(--accent); border-color: var(--accent-line); }
@media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); } .issuer { margin-left: 0; } }
`

const MARK_PATH = 'M15.6 6.4a3.4 3.4 0 0 0-1.8-.5c-2 0-3.3 1.3-3.3 3.5v9.1M7.6 11h6.4'
const favicon = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0f766e"/>` +
  `<path d="${MARK_PATH}" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`)
const brand = html`<span class="brand"><svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect class="mark-bg" width="24" height="24" rx="6"/><path class="mark-fg" d="${MARK_PATH}"/></svg>faux-idc</span>`
const badge = html`<span class="badge" title="Test identity provider. Not for production use.">Test</span>`
const copyIcon = raw('<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>')
const footer = html`<p class="foot">Test identity provider. Not for production use. · v${VERSION}</p>`

/** A button that copies `text`, or the text of the element with id `target`. */
const copyButton = (o: { text?: string; target?: string; label?: string }) => html`<button type="button" class="copy"
  ${o.text !== undefined ? html`data-copy="${o.text}"` : html`data-copy-target="${o.target}"`}
  ${o.label ? '' : raw('aria-label="Copy"')}>${copyIcon}${o.label ? html`<span>${o.label}</span>` : ''}</button>`

// Copies for every [data-copy] button. navigator.clipboard needs a secure context, so plain http hosts use execCommand.
const copyScript = `
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy], [data-copy-target]');
  if (!btn) return;
  e.preventDefault();
  var target = btn.getAttribute('data-copy-target');
  var text = target ? document.getElementById(target).textContent : btn.getAttribute('data-copy');
  function done() {
    btn.classList.add('copied');
    var label = btn.querySelector('span'), old = label && label.textContent;
    if (label) label.textContent = 'Copied';
    setTimeout(function () { btn.classList.remove('copied'); if (label) label.textContent = old; }, 1200);
  }
  function fallback() {
    var area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    try { if (document.execCommand('copy')) done(); } catch (err) {}
    area.remove();
  }
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
});`

const layout = (title: string, body: unknown, o: { wide?: boolean } = {}) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="${favicon}">
<style>${raw(styles)}</style>
</head>
<body${o.wide ? raw(' class="top"') : ''}>
<div class="page${o.wide ? ' wide' : ''}">${body}</div>
<script>${raw(copyScript)}</script>
</body>
</html>`

/** A narrow card with the brand and the test badge on top. */
const card = (body: unknown) => html`<main class="card">
  <div class="card-head">${brand}${badge}</div>
  <div class="card-body">${body}</div>
</main>
${footer}`

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

export function loginPage(o: {
  cfg: Config
  params: Record<string, string | undefined>
  username: string
  claimSet?: string
  error?: string
  /** Set when the Entra gate is on: replaces the password field. */
  entra?: EntraIdentity
}) {
  const claimSets = visibleClaimSets(o.cfg, o.params.scope, o.username)
  const sets = claimSets.map((name) => [name, o.cfg.claimSets[name]] as const)
  const selected = o.claimSet && claimSets.includes(o.claimSet) ? o.claimSet : claimSets[0]
  // Radio cards for a few claim sets; the script below can still switch to the dropdown when the window is short.
  const cards = claimSets.length > 0 && claimSets.length <= MAX_CARDS
  const off = raw(' disabled hidden')
  const descriptions = json(Object.fromEntries(sets.map(([n, s]) => [n, s.description ?? ''])))
  const clientName = o.cfg.clients.find((cl) => cl.clientId === o.params.client_id)?.name
  const hidden = Object.entries(o.params).filter(([, v]) => v !== undefined)
  const switchUrl = `/entra/switch?return=${encodeURIComponent(authorizePath(o.params))}`
  const entraName = o.entra ? o.entra.name || o.entra.username || o.entra.oid : ''
  const initials = entraName.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')

  return layout('Sign in – faux-idc', card(html`
    <h1>Sign in</h1>
    <p class="subtitle">to continue to ${clientName ? html`<strong>${clientName}</strong>` : html`<code>${o.params.client_id}</code>`}</p>
    ${o.error ? html`<p class="error" role="alert">${o.error}</p>` : ''}
    ${o.entra ? html`<div class="identity">
      <span class="avatar" aria-hidden="true">${initials}</span>
      <span class="who"><strong>${entraName}</strong><span>Verified with Microsoft Entra${o.entra.name && o.entra.username ? html` · ${o.entra.username}` : ''}</span></span>
      <a href="${switchUrl}">Switch</a>
    </div>` : ''}
    <form method="post" action="/authorize" id="signin">
      ${hidden.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <div class="field">
        <label class="label" for="username">Username <span class="aside">any name works</span></label>
        <input class="input" id="username" name="username" value="${o.username}" required autocomplete="username" ${o.username ? '' : raw('autofocus')}>
        <p class="help">Used as <code>sub</code> and <code>preferred_username</code>, unless the claim set sets them.</p>
      </div>
      <div class="field">
        <span class="label" id="claim_set_label">Claim set</span>
        <fieldset class="sets" id="sets" aria-labelledby="claim_set_label"${cards ? '' : off}>
          ${sets.map(([n, s]) => html`<label class="set"><input type="radio" name="claim_set" value="${n}"${n === selected ? raw(' checked') : ''}><span class="dot"></span><span><span class="name">${n}</span>${s.description ? html`<span class="desc">${s.description}</span>` : ''}</span></label>`)}
        </fieldset>
        <select name="claim_set" id="claim_set" class="input" aria-labelledby="claim_set_label"${cards ? off : ''}>
          ${sets.map(([n]) => html`<option value="${n}"${n === selected ? raw(' selected') : ''}>${n}</option>`)}
        </select>
        <p class="help" id="set_description">${(selected && o.cfg.claimSets[selected].description) ?? ''}</p>
      </div>
      <details class="claims" id="claims">
        <summary>
          <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Token claims <span class="count" id="claim_count"></span>
          ${copyButton({ target: 'preview', label: 'Copy' })}
        </summary>
        <pre class="json" id="preview"></pre>
      </details>
      ${o.entra ? '' : html`<div class="field">
        <label class="label" for="password">Password <span class="aside">a shared password</span></label>
        <input class="input" type="password" id="password" name="password" required autocomplete="current-password" ${o.username ? raw('autofocus') : ''}>
      </div>`}
      <button class="btn" type="submit" id="submit" ${o.entra ? raw('data-continue-as') : ''} ${o.entra && o.username ? raw('autofocus') : ''}>${o.entra ? `Continue as ${o.username || 'this user'}` : 'Sign in'}</button>
    </form>
    <script>
      (function () {
        var descriptions = ${raw(descriptions)};
        var scope = ${raw(json(o.params.scope ?? ''))};
        var MAX_CARDS = ${MAX_CARDS};
        var page = document.querySelector('.page');
        var sets = document.getElementById('sets');
        var sel = document.getElementById('claim_set');
        var user = document.getElementById('username');
        var desc = document.getElementById('set_description');
        var claims = document.getElementById('claims');
        var out = document.getElementById('preview');
        var count = document.getElementById('claim_count');
        var submit = document.getElementById('submit');
        var timer, resizeTimer, seq = 0;

        function value() {
          if (sets.disabled) return sel.value;
          var checked = sets.querySelector('input:checked');
          return checked ? checked.value : '';
        }
        // Selects a claim set in both pickers, or the first one when it is gone.
        function select(name) {
          sel.value = name;
          if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
          var radios = sets.querySelectorAll('input');
          for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === sel.value;
          desc.textContent = descriptions[sel.value] || '';
        }
        // Radio cards when there are few claim sets and they fit in the window; else the dropdown.
        // The open claims preview does not count, so the picker does not jump when you open it.
        function choose() {
          var current = value();
          var useCards = sel.options.length > 0 && sel.options.length <= MAX_CARDS;
          if (useCards) {
            var picker = sets.hidden ? sel.offsetHeight + desc.offsetHeight : sets.offsetHeight;
            var rest = page.offsetHeight - picker - (claims.open ? out.offsetHeight : 0);
            sets.hidden = false;
            var body = getComputedStyle(document.body);
            var needed = rest + sets.offsetHeight + parseFloat(body.paddingTop) + parseFloat(body.paddingBottom);
            useCards = needed <= window.innerHeight;
          }
          sets.hidden = sets.disabled = !useCards;
          sel.hidden = sel.disabled = useCards;
          select(current);
        }
        function card(s) {
          var label = document.createElement('label'), input = document.createElement('input');
          var dot = document.createElement('span'), text = document.createElement('span'), name = document.createElement('span');
          label.className = 'set'; dot.className = 'dot'; name.className = 'name';
          input.type = 'radio'; input.name = 'claim_set'; input.value = s.name;
          name.textContent = s.name;
          text.appendChild(name);
          if (s.description) {
            var d = document.createElement('span');
            d.className = 'desc'; d.textContent = s.description;
            text.appendChild(d);
          }
          label.append(input, dot, text);
          return label;
        }
        // Rebuilds both pickers: a hidden claim set appears only for its usernames. Keeps the selection.
        function fill(list) {
          var current = value();
          sel.textContent = '';
          sets.textContent = '';
          list.forEach(function (s) {
            descriptions[s.name] = s.description;
            sel.add(new Option(s.name, s.name));
            sets.appendChild(card(s));
          });
          select(current);
          choose();
        }
        function highlight(text) {
          return text.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; })
            .replace(/("(?:\\\\.|[^"\\\\])*")(\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g, function (m, str, colon) {
              if (str) return colon ? '<span class="k">' + str + '</span>' + colon : '<span class="s">' + str + '</span>';
              return '<span class="l">' + m + '</span>';
            });
        }
        function update(refreshSets) {
          clearTimeout(timer);
          timer = setTimeout(function () {
            var mine = ++seq;
            var list = refreshSets
              ? fetch('/claim-sets?scope=' + encodeURIComponent(scope) + '&username=' + encodeURIComponent(user.value)).then(function (r) { return r.json(); })
              : Promise.resolve(null);
            list.then(function (fresh) {
              if (mine !== seq) return;
              if (fresh) fill(fresh);
              if (!value()) { out.textContent = ''; count.textContent = ''; return; }
              return fetch('/claims-preview?claim_set=' + encodeURIComponent(value()) + '&username=' + encodeURIComponent(user.value))
                .then(function (r) { return r.json(); })
                .then(function (data) {
                  if (mine !== seq) return;
                  out.innerHTML = highlight(JSON.stringify(data, null, 2));
                  count.textContent = Object.keys(data).length;
                });
            }).catch(function () { out.textContent = 'Preview unavailable.'; count.textContent = ''; });
          }, 150);
        }
        sets.addEventListener('change', function () { select(value()); update(false); });
        sel.addEventListener('change', function () { select(sel.value); update(false); });
        user.addEventListener('input', function () {
          if (submit.hasAttribute('data-continue-as')) submit.textContent = 'Continue as ' + (user.value.trim() || 'this user');
          update(true);
        });
        window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(choose, 100); });
        choose();
        update(false);
      })();
    </script>`))
}

export function messagePage(title: string, message: string) {
  return layout(`${title} – faux-idc`, card(html`
    <h1>${title}</h1>
    <p class="subtitle">${message}</p>`))
}

export function homePage(cfg: Config, issuer: string) {
  const sets = Object.entries(cfg.claimSets).filter(([, s]) => s.usernames.length === 0)
  const endpoints = [
    ['Discovery', '/.well-known/openid-configuration'], ['JWKS', '/.well-known/jwks.json'], ['Authorize', '/authorize'],
    ['Token', '/token'], ['Userinfo', '/userinfo'], ['Logout', '/logout'],
  ].map(([label, path]) => [label, `${issuer}${path}`])

  return layout('faux-idc', html`
    <header class="topbar">
      ${brand}<span class="ver">v${VERSION}</span>${badge}
      <nav><a href="${issuer}/.well-known/openid-configuration">Discovery</a><a href="${DOCS_URL}">Docs</a></nav>
    </header>
    <section class="card hero">
      <span class="status">Running</span>
      <span class="issuer">Issuer <code>${issuer}</code>${copyButton({ text: issuer, label: 'Copy' })}</span>
    </section>
    <div class="grid">
      <section class="card span">
        <div class="panel-head"><h2>Endpoints</h2><span>OpenID Connect</span></div>
        <ul class="rows">
          ${endpoints.map(([label, url]) => html`<li><span class="lbl">${label}</span><code class="val">${url}</code>${copyButton({ text: url })}</li>`)}
        </ul>
      </section>
      <section class="card">
        <div class="panel-head"><h2>Claim sets</h2><span>${sets.length}</span></div>
        <ul class="rows">
          ${sets.map(([n, s]) => html`<li><span class="main"><code>${n}</code>${s.description ? html`<small>${s.description}</small>` : ''}</span>${s.scopes.length ? html`<span class="tags">${s.scopes.map((sc) => html`<span class="chip">${sc}</span>`)}</span>` : ''}</li>`)}
        </ul>
      </section>
      <section class="card">
        <div class="panel-head"><h2>Clients</h2><span>${cfg.clients.length || 'any'}</span></div>
        <ul class="rows">
          ${cfg.clients.length
            ? cfg.clients.map((cl) => html`<li><span class="main">${cl.name ? html`${cl.name}<small><code>${cl.clientId}</code></small>` : html`<code>${cl.clientId}</code>`}${cl.scopes.length ? html`<small>Owns ${cl.scopes.map((sc) => html`<span class="chip">${sc}</span> `)}</small>` : ''}</span>${cl.clientSecret ? html`<span class="type conf">confidential</span>` : html`<span class="type">public</span>`}</li>`)
            : html`<li><span class="main">Any <code>client_id</code> and redirect URI is accepted.</span></li>`}
        </ul>
      </section>
    </div>
    ${footer}`, { wide: true })
}
