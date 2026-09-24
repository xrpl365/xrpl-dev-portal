#!/usr/bin/env node
// Snapshot the Docs homepage and the Infrastructure section from a running local preview
// (`realm develop`) into plain static pages, for copy review at xrpl-org.xrpl365.com.
//
//   node preview/snapshot.mjs <base-url> <out-dir>
//
// Realm's client runtime refuses to run anywhere but localhost, so the published pages carry
// none of it. Each page is the server-rendered HTML with Realm's scripts removed, plus a small
// script of ours for the only interactive parts in scope:
//   - the sidebar accordion for Infrastructure (collapsed groups are server-rendered empty, so
//     each group's children are taken from that group's own page and filled in),
//   - tab switching (only the first tab panel is server-rendered, so every tab state is captured
//     from the page running normally on localhost),
//   - a click guard: top nav and sidebar entries outside Infrastructure are inert, and content
//     links outside it open the live page on xrpl.org in a new tab.
// Every page also gets a review banner and a noindex tag. XRPLF's analytics (Google Tag
// Manager) and cookie consent (Osano) go with the rest of the scripts.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const [base = 'http://127.0.0.1:4050', outDir = 'preview-dist'] = process.argv.slice(2);
const ORIGIN = new URL(base).origin;
const LIVE = 'https://xrpl.org';
const SNAPSHOT_LABEL = process.env.SNAPSHOT_LABEL || '';

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const inScope = (p) => {
  p = trimSlash(p);
  return p === '/docs' || p === '/docs/infrastructure' || p.startsWith('/docs/infrastructure/');
};

// ---- 1. Find the in-scope pages ------------------------------------------------------------
const pagePaths = [];
{
  const queue = ['/docs', '/docs/infrastructure'];
  const seen = new Set(queue);
  while (queue.length) {
    const p = queue.shift();
    const res = await fetch(ORIGIN + p);
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) {
      console.log(`skipped ${res.status} ${p}`);
      continue;
    }
    const finalPath = trimSlash(new URL(res.url).pathname);
    if (!pagePaths.includes(finalPath)) pagePaths.push(finalPath);
    for (const [, href] of (await res.text()).matchAll(/href="(\/[^"#?]*)/g)) {
      const t = trimSlash(href);
      if (!path.extname(t) && inScope(t) && !seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
}

const browser = await chromium.launch();
// Static view: the server-rendered DOM, with no page scripts running.
const staticCtx = await browser.newContext({ javaScriptEnabled: false });
await staticCtx.route('**/*', (r) => (r.request().resourceType() === 'document' ? r.continue() : r.abort()));
// Live view: the page running normally on localhost, used only to capture tab states.
const liveCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// Keep automated runs out of XRPLF's analytics, and the cookie banner off the tabs.
await liveCtx.route(/osano\.com|googletagmanager\.com|google-analytics\.com/, (r) => r.abort());

const SIDEBAR = 'aside[data-component-name="Sidebar/Sidebar"]';

// Component styles are generated per page for only what that page renders, so markup moved
// between pages (sidebar groups, tab states) needs rules from elsewhere. Every page's rules are
// pooled, and each page gets only the component rules it is missing, appended after its own.
const styledRules = new Set();
// Rules are read from the style text (styled-components separates them with /*!sc*/), not from
// CSSOM: CSSOM serializes var() shorthands such as `padding: var(--x)` as empty longhands, which
// silently drops them when the text is reused.
const collectStyles = () =>
  [...document.querySelectorAll('style[data-styled]')].flatMap((s) =>
    s.textContent.split('/*!sc*/').map((r) => r.trim()).filter(Boolean),
  );

// ---- 2. Sidebar: each group's children, as rendered on that group's own page ----------------
const groupChildren = {};
{
  const page = await staticCtx.newPage();
  for (const p of pagePaths) {
    await page.goto(ORIGIN + p, { waitUntil: 'domcontentloaded' });
    const html = await page.evaluate(
      ({ SIDEBAR, p }) => {
        const a = document.querySelector(`${SIDEBAR} [data-component-name="Menu/MenuItem"] > a[href="${p}"]`);
        const wrap = a && a.parentElement.querySelector(':scope > div');
        return wrap && wrap.children.length ? wrap.innerHTML : null;
      },
      { SIDEBAR, p },
    );
    if (html) groupChildren[p] = html;
    (await page.evaluate(collectStyles)).forEach((r) => styledRules.add(r));
  }
  await page.close();
}

// ---- 3. Tabs: capture each tab's selected state from the running page ------------------------
const TABS = '[data-component-name="Markdoc/Tabs/Tabs"]';
const tabStates = {};
{
  const page = await liveCtx.newPage();
  for (const p of pagePaths) {
    const probe = await fetch(ORIGIN + p).then((r) => r.text());
    if (!probe.includes('Markdoc/Tabs/Tabs')) continue;
    await page.goto(ORIGIN + p, { waitUntil: 'networkidle' });
    const groups = [];
    const count = await page.locator(TABS).count();
    for (let i = 0; i < count; i++) {
      const box = page.locator(TABS).nth(i);
      const tabs = box.locator('[role="tab"]');
      const variants = [];
      for (let j = 0; j < (await tabs.count()); j++) {
        await tabs.nth(j).evaluate((el) => el.click());
        await page.waitForTimeout(250);
        variants.push({ label: await tabs.nth(j).getAttribute('data-label'), html: await box.evaluate((el) => el.outerHTML) });
      }
      groups.push(variants);
    }
    tabStates[p] = groups;
    (await page.evaluate(collectStyles)).forEach((r) => styledRules.add(r));
  }
  await page.close();
}

// Global rules (:root variables, html/body, fonts) are never copied between pages: they carry
// page- and state-specific values that would override the page's own.
const pooledRules = [...styledRules].filter((r) => !/^\s*(:root|html|body|\*|@font-face)/.test(r));

// ---- 4. Build each static page ---------------------------------------------------------------
const BANNER_TEXT =
  'Preview of proposed changes for review. Not the official xrpl.org.' +
  (SNAPSHOT_LABEL ? ` Snapshot: ${SNAPSHOT_LABEL}.` : '');

const HEAD_INJECT = `<meta name="robots" content="noindex, nofollow">
<style>
#xrpl365-preview-banner{position:relative;z-index:10000;background:#ffd166;color:#111;font:600 13px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:6px 12px}
#xrpl365-preview-banner a{color:#111;text-decoration:underline}
header.bds-navbar a,header.bds-navbar button,#bds-mobile-menu a,
${SIDEBAR} [data-component-name="Menu/MenuItem"]:not([data-preview-scope]) > a{cursor:default}
[data-preview-group] > a [class*="ChevronWrapper"] svg{transition:transform .15s}
[data-preview-group][data-preview-open] > a [class*="ChevronWrapper"] svg{transform:rotate(90deg)}
</style>
<script>
(function () {
  var LIVE = ${JSON.stringify(LIVE)};
  var MENU = 'header.bds-navbar, #bds-mobile-menu, ${SIDEBAR}';
  function inScope(p) {
    p = p.length > 1 ? p.replace(/\\/+$/, '') : p;
    return p === '/docs' || p === '/docs/infrastructure' || p.indexOf('/docs/infrastructure/') === 0;
  }
  function showTab(label) {
    // Tabs are synced by label across the page, as on the real site.
    document.querySelectorAll('[data-preview-tabs]').forEach(function (set) {
      var variants = set.children, hit = -1;
      for (var i = 0; i < variants.length; i++) if (variants[i].getAttribute('data-preview-label') === label) hit = i;
      if (hit < 0) return;
      for (var k = 0; k < variants.length; k++) variants[k].hidden = k !== hit;
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var tab = t.closest('[data-preview-tabs] [role="tab"]');
    if (tab) { e.preventDefault(); showTab(tab.getAttribute('data-label')); return; }

    var menu = t.closest(MENU);
    var item = menu && t.closest('[data-component-name="Menu/MenuItem"]');
    var a = item ? item.querySelector(':scope > a[href]') : t.closest('a[href]');
    if (!a) { if (menu) e.preventDefault(); return; }
    var u = new URL(a.getAttribute('href'), location.href);
    if (u.origin !== location.origin) { if (menu) e.preventDefault(); return; }

    if (!inScope(u.pathname)) {
      e.preventDefault();
      if (!menu) window.open(LIVE + u.pathname + u.search + u.hash, '_blank', 'noopener');
      return;
    }
    // Infrastructure groups: the chevron opens and closes; the label goes to the group's page.
    if (item && item.hasAttribute('data-preview-group') && t.closest('[class*="ChevronWrapper"]')) {
      e.preventDefault();
      var open = !item.hasAttribute('data-preview-open');
      item.toggleAttribute('data-preview-open', open);
      var wrap = item.querySelector(':scope > div');
      wrap.style.display = open ? '' : 'none';
      wrap.style.height = open ? '' : '0px';
    }
  }, true);
})();
</script>
`;
const BODY_INJECT = `<div id="xrpl365-preview-banner" role="note">${BANNER_TEXT} <a href="${LIVE}/docs" target="_blank" rel="noopener">Go to xrpl.org</a></div>`;

function transform({ SIDEBAR, TABS, groupChildren, tabs, HEAD_INJECT, BODY_INJECT, pooledRules }) {
  const inScope = (p) => {
    p = p.length > 1 ? p.replace(/\/+$/, '') : p;
    return p === '/docs' || p === '/docs/infrastructure' || p.startsWith('/docs/infrastructure/');
  };

  // Realm's scripts, module preloads, and third-party trackers. The site's own theme-switch.js
  // stays: it applies the saved or OS light/dark preference before first paint, as on xrpl.org.
  document
    .querySelectorAll('script:not([src*="/assets/theme-switch"]), noscript, link[rel="modulepreload"], link[as="script"], link[as="fetch"]')
    .forEach((n) => n.remove());
  document
    .querySelectorAll('link[href*="osano.com"], link[href*="googletagmanager.com"]')
    .forEach((n) => n.remove());

  // Sidebar: fill every collapsed Infrastructure group, then mark groups for the accordion.
  const side = document.querySelector(SIDEBAR);
  const rightChevron = side && side.querySelector('[data-component-name="icons/ChevronRightIcon/ChevronRightIcon"]');
  const missing = [];
  if (side) {
    for (let pass = 0; pass < 10; pass++) {
      let filled = 0;
      side.querySelectorAll('[data-component-name="Menu/MenuItem"] > a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        const wrap = a.parentElement.querySelector(':scope > div');
        if (!wrap || wrap.children.length || !inScope(href) || href === '/docs') return;
        if (!a.parentElement.classList.contains('menu-item-type-group')) return;
        if (groupChildren[href]) {
          wrap.innerHTML = groupChildren[href];
          wrap.setAttribute('style', 'display:none;height:0px;overflow:hidden');
          filled++;
        } else if (!missing.includes(href)) missing.push(href);
      });
      if (!filled) break;
    }
    side.querySelectorAll('[data-component-name="Menu/MenuItem"] > a[href]').forEach((a) => {
      const item = a.parentElement;
      const href = a.getAttribute('href');
      if (!inScope(href)) return;
      item.setAttribute('data-preview-scope', '');
      if (href === '/docs' || !item.classList.contains('menu-item-type-group')) return;
      const wrap = item.querySelector(':scope > div');
      if (!wrap || !wrap.children.length) return;
      item.setAttribute('data-preview-group', '');
      const open = wrap.style.display !== 'none';
      if (open) item.setAttribute('data-preview-open', '');
      // One chevron shape everywhere; CSS turns it down when the group is open.
      const chev = a.querySelector('[class*="ChevronWrapper"]');
      if (chev && rightChevron) chev.innerHTML = rightChevron.outerHTML;
    });
  }

  // Tabs: replace each server-rendered tab set with all of its captured states.
  const sets = document.querySelectorAll(TABS);
  (tabs || []).forEach((variants, i) => {
    const set = sets[i];
    if (!set || !variants.length) return;
    const holder = document.createElement('div');
    holder.setAttribute('data-preview-tabs', '');
    holder.innerHTML = variants
      .map((v, k) => `<div data-preview-label="${v.label.replace(/"/g, '&quot;')}"${k ? ' hidden' : ''}>${v.html}</div>`)
      .join('');
    set.replaceWith(holder);
  });

  document.head.insertAdjacentHTML('afterbegin', HEAD_INJECT);
  const own = new Set(
    [...document.querySelectorAll('style[data-styled]')].flatMap((st) =>
      st.textContent.split('/*!sc*/').map((r) => r.trim()).filter(Boolean),
    ),
  );
  const extra = pooledRules.filter((r) => !own.has(r));
  if (extra.length) {
    const st = document.createElement('style');
    st.setAttribute('data-preview-styles', '');
    st.textContent = extra.join('\n');
    document.head.appendChild(st);
  }
  document.body.insertAdjacentHTML('afterbegin', BODY_INJECT);
  return { html: '<!DOCTYPE html>\n' + document.documentElement.outerHTML, missing };
}

const pages = new Map();
const missingGroups = new Set();
{
  const page = await staticCtx.newPage();
  for (const p of pagePaths) {
    await page.goto(ORIGIN + p, { waitUntil: 'domcontentloaded' });
    const { html, missing } = await page.evaluate(transform, {
      SIDEBAR,
      TABS,
      groupChildren,
      tabs: tabStates[p],
      HEAD_INJECT,
      BODY_INJECT,
      pooledRules,
    });
    missing.forEach((m) => missingGroups.add(m));
    pages.set(p, html);
  }
  await page.close();
}
await browser.close();

// ---- 5. Assets: stylesheets, fonts, images -----------------------------------------------------
const ASSET_ABS = /["'(\s=,]((?:\/(?:assets|runtime|font|fonts|img|images|static)\/)[^"'()\s<>,\\]*)/g;
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g;
const files = new Map();
const failed = [];
const queue = [];
const seen = new Set();
const add = (p) => {
  p = p.split(/[?#]/)[0];
  if (p && !seen.has(p) && (!/\.m?js$/.test(p) || p.includes('/theme-switch'))) {
    seen.add(p);
    queue.push(p);
  }
};
for (const html of pages.values()) for (const [, p] of html.matchAll(ASSET_ABS)) add(p);
while (queue.length) {
  const p = queue.shift();
  const res = await fetch(ORIGIN + p);
  if (!res.ok) {
    failed.push(`${res.status} ${p}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  files.set(p, buf);
  if (p.endsWith('.css')) {
    for (const [, u, imp] of buf.toString('utf8').matchAll(CSS_URL)) {
      const ref = u || imp;
      if (ref && !/^(data:|https?:|#)/.test(ref)) add(new URL(ref, ORIGIN + p).pathname);
    }
  }
}

// ---- 6. Write the site ----------------------------------------------------------------------------
await rm(outDir, { recursive: true, force: true });
for (const [p, html] of pages) {
  const dest = path.join(outDir, p, 'index.html');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, html);
}
for (const [p, buf] of files) {
  const dest = path.join(outDir, p);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
}
await writeFile(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

const tabbed = Object.keys(tabStates).length;
console.log(`snapshot: ${pages.size} pages (${tabbed} with tabs), ${files.size} files -> ${outDir}`);
if (missingGroups.size) console.log(`warning: sidebar groups with no captured children: ${[...missingGroups].join(', ')}`);
if (failed.length) {
  console.log(`not fetched: ${failed.length} (VERBOSE=1 to list)`);
  if (process.env.VERBOSE) console.log('  ' + failed.join('\n  '));
}
