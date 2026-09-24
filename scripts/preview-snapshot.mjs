#!/usr/bin/env node
// Snapshot the Docs homepage and the Infrastructure section from a running local preview
// (`realm develop`) into a static folder, for copy review at xrpl-org.xrpl365.com.
//
//   node scripts/preview-snapshot.mjs <base-url> <out-dir>
//
// A production `realm build` needs a Redocly plan token, so the dev server's server-rendered
// pages are the only buildable output. Pages keep their scripts so the sidebar and client-side
// navigation behave like the real site; the runtime's ES module imports and each page's
// page-data JSON are followed so they resolve from the static host.
//
// Every page gets a review banner, a noindex tag, and a click guard: menu entries outside the
// review scope do nothing, and content links outside it open the live page on xrpl.org.
// XRPLF's analytics (Google Tag Manager) and cookie consent (Osano) are stripped.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [base = 'http://127.0.0.1:4050', outDir = 'preview-dist'] = process.argv.slice(2);
const ORIGIN = new URL(base).origin;
const LIVE = 'https://xrpl.org';
const SNAPSHOT_LABEL = process.env.SNAPSHOT_LABEL || '';

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const inScope = (p) => {
  p = trimSlash(p);
  return p === '/docs' || p === '/docs/infrastructure' || p.startsWith('/docs/infrastructure/');
};
// Page data is per page; only fetch it for pages in scope (plus the shared sidebar data).
const wantedPageData = (p) => {
  const m = p.match(/^\/page-data\/(.*)\/data\.json$/);
  return p.startsWith('/page-data/shared/') || (m && inScope('/' + m[1]));
};

const pages = new Map(); // path -> html
const files = new Map(); // path -> Buffer
const missing = [];

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return res;
}

// ---- 1. Crawl in-scope pages -------------------------------------------------------------
const queue = ['/docs', '/docs/infrastructure'];
const seen = new Set(queue);
while (queue.length) {
  const p = queue.shift();
  const res = await get(ORIGIN + p);
  const finalPath = trimSlash(new URL(res.url).pathname);
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) {
    missing.push(`${res.status} ${p}`);
    continue;
  }
  const html = await res.text();
  pages.set(finalPath, html);
  for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
    const t = trimSlash(href);
    if (!path.extname(t) && inScope(t) && !seen.has(t)) {
      seen.add(t);
      queue.push(t);
    }
  }
}

// ---- 2. Follow assets, runtime modules, page data -----------------------------------------
const ASSET_ABS = /["'(\s=,]((?:\/(?:assets|runtime|page-data|font|fonts|img|images|static)\/|\/app-data\.json)[^"'()\s<>,\\]*)/g;
const JS_REL = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g;

const assetQueue = [];
const assetSeen = new Set();
function addAsset(p) {
  p = p.split(/[?#]/)[0];
  if (!p || assetSeen.has(p)) return;
  if (p.startsWith('/page-data/') && !wantedPageData(p)) return;
  assetSeen.add(p);
  assetQueue.push(p);
}
function scan(text, fromPath) {
  for (const [, p] of text.matchAll(ASSET_ABS)) addAsset(p);
  if (/\.m?js$/.test(fromPath)) {
    for (const [, rel] of text.matchAll(JS_REL)) addAsset(new URL(rel, ORIGIN + fromPath).pathname);
  }
  if (fromPath.endsWith('.css')) {
    for (const [, u, imp] of text.matchAll(CSS_URL)) {
      const ref = u || imp;
      if (ref && !/^(data:|https?:|#)/.test(ref)) addAsset(new URL(ref, ORIGIN + fromPath).pathname);
    }
  }
}
for (const [p, html] of pages) scan(html, p);
while (assetQueue.length) {
  const p = assetQueue.shift();
  const res = await get(ORIGIN + p);
  if (!res.ok) {
    missing.push(`${res.status} ${p}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  files.set(p, buf);
  if (/\.(m?js|css|json)$/.test(p)) scan(buf.toString('utf8'), p);
}

// ---- 3. Rewrite pages for review -----------------------------------------------------------
const BANNER_TEXT =
  'Preview of proposed changes for review. Not the official xrpl.org.' +
  (SNAPSHOT_LABEL ? ` Snapshot: ${SNAPSHOT_LABEL}.` : '');

const HEAD_INJECT = `<meta name="robots" content="noindex, nofollow">
<style>
#xrpl365-preview-banner{position:relative;z-index:10000;background:#ffd166;color:#111;font:600 13px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:6px 12px}
#xrpl365-preview-banner a{color:#111;text-decoration:underline}
header.bds-navbar a:not([href="/docs"]):not([href="/docs/"]):not([href^="/docs/infrastructure"]),
#bds-mobile-menu a:not([href="/docs"]):not([href="/docs/"]):not([href^="/docs/infrastructure"]),
aside[data-component-name="Sidebar/Sidebar"] a:not([href^="/docs/infrastructure"]){cursor:default}
</style>
<script>
(function () {
  // The dev runtime opens a live-reload socket at "/" and reloads the page whenever it closes.
  // There is no dev server behind the static host, so hand that one socket a stub that stays idle.
  var NativeWS = window.WebSocket;
  var StubbedWS = function (url, protocols) {
    try {
      var u = new URL(url, location.href);
      if (u.host === location.host && u.pathname === '/') {
        var noop = function () {};
        return { readyState: 0, addEventListener: noop, removeEventListener: noop, send: noop, close: noop };
      }
    } catch (err) {}
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  };
  StubbedWS.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { StubbedWS[k] = NativeWS[k]; });
  window.WebSocket = StubbedWS;

  var LIVE = ${JSON.stringify(LIVE)};
  function inScope(p) {
    p = p.length > 1 ? p.replace(/\\/+$/, '') : p;
    return p === '/docs' || p === '/docs/infrastructure' || p.indexOf('/docs/infrastructure/') === 0;
  }
  var MENU = 'header.bds-navbar, #bds-mobile-menu, aside[data-component-name="Sidebar/Sidebar"]';
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var menu = t.closest(MENU);
    var a = t.closest('a[href]');
    // A sidebar entry (label and expand arrow) follows its own link, so out-of-scope
    // sections neither navigate nor expand.
    var item = menu && t.closest('[data-component-name="Menu/MenuItem"]');
    if (item) a = item.querySelector('a[href]') || a;
    if (!a) return;
    var u = new URL(a.getAttribute('href'), location.href);
    if (u.origin !== location.origin || inScope(u.pathname)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!menu) window.open(LIVE + u.pathname + u.search + u.hash, '_blank', 'noopener');
  }, true);
})();
</script>
`;
const BODY_INJECT = `<div id="xrpl365-preview-banner" role="note">${BANNER_TEXT} <a href="${LIVE}/docs" target="_blank" rel="noopener">Go to xrpl.org</a></div>`;

function stripScripts(html) {
  return html
    .replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?googletagmanager(?:(?!<\/script>)[\s\S])*?<\/script>/g, '')
    .replace(/<noscript>(?:(?!<\/noscript>)[\s\S])*?googletagmanager(?:(?!<\/noscript>)[\s\S])*?<\/noscript>/g, '')
    .replace(/<script\b[^>]*\bsrc="[^"]*osano[^"]*"[^>]*>\s*<\/script>/gi, '')
    .replace(/<link\b[^>]*\bhref="https:\/\/(?:cmp\.osano\.com|www\.googletagmanager\.com)[^"]*"[^>]*>/gi, '');
}

function review(html) {
  html = stripScripts(html);
  if (!/<head[^>]*>/.test(html) || !/<body[^>]*>/.test(html)) throw new Error('unexpected page shape');
  return html.replace(/<head([^>]*)>/, (m) => m + HEAD_INJECT).replace(/<body([^>]*)>/, (m) => m + BODY_INJECT);
}

// ---- 4. Write the site -----------------------------------------------------------------------
await rm(outDir, { recursive: true, force: true });
for (const [p, html] of pages) {
  const dest = path.join(outDir, p, 'index.html');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, review(html));
}
for (const [p, buf] of files) {
  if (p.endsWith('/osano.js') || /\/osano\.[^/]+\.js$/.test(p)) continue;
  const dest = path.join(outDir, p);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
}
await writeFile(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const leftovers = [...pages.values()].map(review).filter((h) => /googletagmanager|osano/i.test(h)).length;
console.log(`snapshot: ${pages.size} pages, ${files.size} files -> ${outDir}`);
if (leftovers) console.log(`warning: ${leftovers} pages still mention googletagmanager/osano`);
// A handful of misses is normal: path-like strings inside JS bundles, and images that only
// other sections of the site use. VERBOSE=1 lists them.
if (missing.length) {
  console.log(`not fetched: ${missing.length} (usually harmless; VERBOSE=1 to list)`);
  if (process.env.VERBOSE) console.log('  ' + missing.join('\n  '));
}
