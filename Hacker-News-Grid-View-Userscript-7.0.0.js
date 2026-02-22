// ==UserScript==
// @name         HN Grid View
// @version      7.0.0
// @description  Hacker News as a visual card grid with split-pane reader
// @author       Qahlel
// @match        https://news.ycombinator.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Only run on listing pages ─────────────────────────────────────────────
  const p = location.pathname;
  const isListPage =
    p === '/' ||
    /^\/(news|front|newest|ask|show|jobs)\/?$/.test(p) ||
    location.search.startsWith('?p=');
  if (!isListPage) return;

  // ── GM fetch (bypasses CORS) ──────────────────────────────────────────────
  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:        'GET',
        url,
        timeout:       opts.timeout || 15000,
        responseType:  opts.responseType || 'text',
        headers: {
          'Accept':          opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent':      navigator.userAgent,
        },
        onload:    r  => resolve(r),
        onerror:  () => reject(new Error('network')),
        ontimeout:() => reject(new Error('timeout')),
      });
    });
  }

  // ── og:image extraction — two-pass, handles multi-line meta tags ──────────
  //
  //  Pass 1: extract each <meta ...> tag as a complete string.
  //          [^>]* in JS character class DOES match \n, so multi-line tags work.
  //  Pass 2: check each tag independently for property/name + content attrs.
  //
  function extractOgImage(html, baseUrl) {
    const tagRe = /<meta\b([^>]*)(?:\/>|>)/gi;
    let tag;
    while ((tag = tagRe.exec(html)) !== null) {
      const attrs = tag[1];
      const isImageTag =
        /(?:property|name)\s*=\s*["']og:image(?::secure_url|:url)?["']/i.test(attrs) ||
        /(?:property|name)\s*=\s*["']twitter:image(?::src)?["']/i.test(attrs);
      if (!isImageTag) continue;
      const cm = attrs.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
      if (!cm || !cm[1] || cm[1].startsWith('data:')) continue;
      try {
        const resolved = new URL(cm[1], baseUrl).href;
        if (/\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i.test(resolved) ||
            /image/i.test(resolved) ||
            !/\.(js|css|html?)(\?|$)/i.test(resolved)) {
          return resolved;
        }
      } catch (_) {}
    }
    return null;
  }

  function extractFallbackImage(html, baseUrl) {
    const heroKw = /hero|banner|cover|feature|article|post|thumb|social|preview|splash|header/i;
    const badKw  = /icon|logo|avatar|sprite|pixel|1x1|spacer|button|badge|flag|emoji/i;
    const imgRe  = /<img\b([^>]*)>/gi;
    let best = null, bestScore = -99;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
      const attrs = m[1];
      const srcM  = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!srcM || !srcM[1] || srcM[1].startsWith('data:') ||
          /\.svg(\?|$)/i.test(srcM[1])) continue;
      let score = 0;
      if (heroKw.test(srcM[1]))  score += 15;
      if (badKw.test(srcM[1]))   score -= 25;
      const wM = attrs.match(/\bwidth\s*=\s*["']?(\d+)/i);
      const hM = attrs.match(/\bheight\s*=\s*["']?(\d+)/i);
      if (wM) score += Math.min(parseInt(wM[1], 10) / 50, 12);
      if (hM) score += Math.min(parseInt(hM[1], 10) / 80, 8);
      if (wM && parseInt(wM[1], 10) < 80) score -= 20;
      if (score > bestScore) { bestScore = score; best = srcM[1]; }
    }
    if (!best || bestScore < 5) return null;
    try { return new URL(best, baseUrl).href; } catch (_) { return null; }
  }

  // ── Thumb cache + fetch pipeline ─────────────────────────────────────────
  // Returns the raw og:image URL (not a blob/data URL).
  // The caller (drain) injects it via GM_addElement which bypasses HN's img-src CSP.
  // referrerpolicy="no-referrer" on the injected img handles hotlink protection.
  const thumbMem = new Map();  // pageUrl → og:image URL | null

  async function getThumb(url) {
    if (thumbMem.has(url)) return thumbMem.get(url);

    // sessionStorage caches the resolved og:image URL string (a few dozen bytes)
    const sk = 'hng66::' + url;
    try {
      const stored = sessionStorage.getItem(sk);
      if (stored !== null) {
        const v = stored || null;
        thumbMem.set(url, v);
        return v;
      }
    } catch (_) {}

    let srcUrl = null;
    try {
      const r    = await gmFetch(url);
      const html = r.responseText || '';
      const base = r.finalUrl || url;
      if (html) srcUrl = extractOgImage(html, base) || extractFallbackImage(html, base);
    } catch (_) {}

    thumbMem.set(url, srcUrl);
    try { sessionStorage.setItem(sk, srcUrl || ''); } catch (_) {}
    return srcUrl;
  }

  const FAVICON = d =>
    `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${d}&size=64`;

  // ── Parse HN stories from DOM ─────────────────────────────────────────────
  function parseStories() {
    return [...document.querySelectorAll('tr.athing')].map((row, i) => {
      const sub = row.nextElementSibling;
      if (!sub) return null;
      const a = row.querySelector('td.title span.titleline > a, td.title a.titlelink');
      if (!a) return null;

      const title   = a.textContent.trim();
      const href    = a.getAttribute('href') || '';
      const isHN    = !href.includes('://') || href.includes('ycombinator.com/item');
      const fullUrl = isHN
        ? `https://news.ycombinator.com/${href.replace(/^\//, '')}`
        : href;
      const id     = row.id;
      const domain = row.querySelector('.sitestr')?.textContent?.trim() || null;
      const points = sub.querySelector('.score')?.textContent?.trim()   || null;
      const age    = sub.querySelector('.age')?.textContent?.trim()     || '';

      const cmtLink = [...sub.querySelectorAll('a')]
        .find(l => /\d+\s*comment|discuss/i.test(l.textContent));
      const cmtText = cmtLink?.textContent?.trim() || 'discuss';
      const cmtHref = `https://news.ycombinator.com/item?id=${id}`;

      let tag = null;
      if      (title.startsWith('Ask HN:'))    tag = 'Ask HN';
      else if (title.startsWith('Show HN:'))   tag = 'Show HN';
      else if (title.startsWith('Tell HN:'))   tag = 'Tell HN';
      else if (title.startsWith('Launch HN:')) tag = 'Launch';

      return { id, title, url: fullUrl, domain, isHN, points, age, cmtText, cmtHref, tag, rank: i + 1 };
    }).filter(Boolean);
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    const el = document.createElement('style');
    el.textContent = `
      html, body { margin:0; padding:0; background:#f6f6ef; }

      /* topbar: always directly on <body>, never toggled */
      #hng-bar {
        display:flex; align-items:center; gap:10px; flex-wrap:wrap;
        padding:7px 16px; background:#ff6600; position:sticky; top:0; z-index:200;
        width:100%; box-sizing:border-box;
      }
      #hng-bar .hng-logo {
        font:bold 13px/1 Verdana,sans-serif; color:#000; background:#fff;
        padding:2px 6px; border-radius:2px; text-decoration:none;
      }
      #hng-bar nav a {
        font:12px Verdana,sans-serif; color:#000; text-decoration:none; margin-right:6px;
      }
      #hng-bar nav a:hover { text-decoration:underline; }
      #hng-toggle {
        margin-left:auto; padding:3px 11px; border-radius:4px; cursor:pointer;
        font:12px Verdana,sans-serif; border:1px solid rgba(0,0,0,.25);
        background:rgba(0,0,0,.15); color:#000;
      }
      #hng-toggle:hover { background:rgba(0,0,0,.28); }
      #hng-search-form { display:flex; align-items:center; gap:4px; margin-left:8px; }
      #hng-search-input {
        padding:3px 8px; border-radius:4px; border:none; outline:none;
        font:12px Verdana,sans-serif; width:160px; background:rgba(255,255,255,.85);
        color:#000;
      }
      #hng-search-input:focus { background:#fff; width:220px; transition:width .2s; }
      #hng-search-btn {
        padding:3px 9px; border-radius:4px; cursor:pointer;
        font:12px Verdana,sans-serif; border:1px solid rgba(0,0,0,.25);
        background:rgba(0,0,0,.15); color:#000; white-space:nowrap;
      }
      #hng-search-btn:hover { background:rgba(0,0,0,.28); }

      /* grid */
      #hng-grid {
        display:grid;
        grid-template-columns:repeat(auto-fill,minmax(270px,1fr));
        gap:15px; padding:18px; max-width:1900px; margin:0 auto; box-sizing:border-box;
      }

      /* card */
      .hng-card {
        background:#fff; border-radius:8px; overflow:hidden;
        box-shadow:0 1px 4px rgba(0,0,0,.10);
        display:flex; flex-direction:column;
        transition:box-shadow .15s, transform .15s; cursor:pointer;
      }
      .hng-card:hover { box-shadow:0 5px 18px rgba(0,0,0,.16); transform:translateY(-2px); }

      /* thumbnail */
      .hng-thumb {
        position:relative; width:100%; aspect-ratio:5/3;
        background:#e8e8df; overflow:hidden; flex-shrink:0;
      }
      .hng-thumb-img {
        position:absolute; inset:0; width:100%; height:100%;
        object-fit:cover; opacity:0; transition:opacity .5s; display:block;
      }
      .hng-thumb-img.ready  { opacity:1; }
      .hng-thumb-img.failed { display:none; }
      .hng-fallback {
        position:absolute; inset:0; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:8px;
        background:linear-gradient(135deg,#f0efe8,#e2dfd4); transition:opacity .3s;
      }
      .hng-fallback.gone { opacity:0; pointer-events:none; }
      .hng-fallback img  { width:44px; height:44px; border-radius:8px; }
      .hng-fallback span {
        font:10px Verdana,sans-serif; color:#999; max-width:80%;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .hng-rank {
        position:absolute; top:8px; left:8px; z-index:2;
        background:rgba(0,0,0,.55); color:#fff; backdrop-filter:blur(4px);
        font:bold 11px Verdana,sans-serif; padding:2px 7px; border-radius:4px;
      }
      .hng-tag {
        position:absolute; top:8px; right:8px; z-index:2;
        background:#ff6600; color:#fff;
        font:bold 10px Verdana,sans-serif; padding:2px 7px; border-radius:4px;
      }

      /* card body */
      .hng-body { padding:11px 13px 10px; display:flex; flex-direction:column; flex:1; gap:5px; }
      .hng-title {
        font:600 13px/1.4 Verdana,sans-serif; color:#1a1a1a;
        display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;
      }
      .hng-domain { font:10px Verdana,sans-serif; color:#aaa; }
      .hng-meta {
        display:flex; align-items:center; gap:8px; margin-top:auto;
        padding-top:7px; border-top:1px solid #f0ede4; flex-wrap:wrap;
      }
      .hng-pts { font:bold 11px Verdana,sans-serif; color:#ff6600; }
      .hng-age { font:11px Verdana,sans-serif; color:#bbb; }
      .hng-cmt {
        margin-left:auto; font:11px Verdana,sans-serif; color:#828282;
        display:flex; align-items:center; gap:3px; text-decoration:none;
      }
      .hng-cmt:hover { color:#ff6600; }

      /* more / footer */
      #hng-more { text-align:center; padding:12px 0 28px; }
      #hng-more a {
        font:13px Verdana,sans-serif; color:#828282; background:#fff;
        padding:8px 24px; border-radius:6px; box-shadow:0 1px 3px rgba(0,0,0,.10);
        text-decoration:none; display:inline-block;
      }
      #hng-more a:hover { color:#ff6600; }
      #hng-footer {
        text-align:center; padding:12px; border-top:1px solid #ddd;
        font:10px Verdana,sans-serif; color:#828282;
      }
      #hng-footer a { color:#828282; text-decoration:none; }
      #hng-footer a:hover { text-decoration:underline; }

      /* split overlay */
      #hng-split {
        display:none; position:fixed; inset:0; z-index:9999;
        background:#111; flex-direction:column;
      }
      #hng-split.open { display:flex; }

      #hng-sbar {
        display:flex; align-items:center; gap:8px; padding:6px 12px;
        background:#ff6600; flex-shrink:0;
      }
      #hng-stitle {
        font:bold 12px Verdana,sans-serif; color:#000;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0;
      }
      .hng-sbtn {
        padding:3px 10px; border-radius:4px; cursor:pointer; white-space:nowrap;
        font:12px Verdana,sans-serif; border:1px solid rgba(0,0,0,.25);
        background:rgba(0,0,0,.15); color:#000; flex-shrink:0;
      }
      .hng-sbtn:hover { background:rgba(0,0,0,.28); }

      #hng-spanes { display:flex; flex:1; overflow:hidden; gap:2px; }
      .hng-pane { flex:1; display:flex; flex-direction:column; background:#fff; min-width:0; position:relative; }
      .hng-plabel {
        display:flex; align-items:center; gap:8px; padding:4px 10px;
        background:#f6f6ef; border-bottom:1px solid #ddd;
        font:bold 10px Verdana,sans-serif; color:#828282; flex-shrink:0;
      }
      .hng-plabel a { color:#ff6600; font:10px Verdana,sans-serif; margin-left:auto; text-decoration:none; }
      .hng-plabel a:hover { text-decoration:underline; }
      .hng-pane iframe { flex:1; border:none; width:100%; height:100%; display:block; }

      /* loading spinner on article pane */
      #hng-art-loading {
        display:none; position:absolute; inset:0; background:#f6f6ef;
        align-items:center; justify-content:center; z-index:5;
        font:13px Verdana,sans-serif; color:#828282;
      }
      #hng-art-loading.show { display:flex; }
      .hng-spinner {
        width:26px; height:26px; border:3px solid #ddd; border-top-color:#ff6600;
        border-radius:50%; animation:hng-spin .7s linear infinite; margin-right:12px;
      }
      @keyframes hng-spin { to { transform:rotate(360deg); } }

      /* resize handle */
      #hng-handle {
        width:5px; background:#333; cursor:col-resize; flex-shrink:0; transition:background .15s;
      }
      #hng-handle:hover, #hng-handle.on { background:#ff6600; }
    `;
    document.head.appendChild(el);
  }

  // ── Build card grid ───────────────────────────────────────────────────────
  function buildCards(stories) {
    const grid = document.createElement('div');
    grid.id = 'hng-grid';

    stories.forEach(s => {
      const card = document.createElement('div');
      card.className  = 'hng-card';
      card.dataset.url   = s.url;
      card.dataset.cmt   = s.cmtHref;
      card.dataset.title = s.title;
      card.dataset.isHN  = s.isHN ? '1' : '';

      // ── thumbnail ──
      const thumb = document.createElement('div');
      thumb.className = 'hng-thumb';

      const rankEl = document.createElement('span');
      rankEl.className  = 'hng-rank';
      rankEl.textContent = s.rank;
      thumb.appendChild(rankEl);

      if (s.tag) {
        const t = document.createElement('span');
        t.className   = 'hng-tag';
        t.textContent = s.tag;
        thumb.appendChild(t);
      }

      // Fallback: favicon + domain.
      // Favicon img is NOT created here — it would be subject to HN's img-src CSP.
      // We mark the fb div and add the img via GM_addElement after DOM insertion.
      const fb = document.createElement('div');
      fb.className = 'hng-fallback';
      if (s.domain) fb.dataset.faviconUrl = FAVICON(s.domain);
      const fl = document.createElement('span');
      fl.textContent = s.domain || 'news.ycombinator.com';
      fb.appendChild(fl);
      thumb.appendChild(fb);

      // Mark thumb with page URL — GM_addElement img added after DOM insertion.
      if (!s.isHN && s.domain) {
        thumb.dataset.pageUrl = s.url;
        thumb.dataset.fbId    = 'fb-' + s.id; // tie thumb back to its fb div
        fb.id = 'fb-' + s.id;
      }

      card.appendChild(thumb);

      // ── card body ──
      const body = document.createElement('div');
      body.className = 'hng-body';

      const titleEl = document.createElement('div');
      titleEl.className  = 'hng-title';
      titleEl.textContent = s.title;
      body.appendChild(titleEl);

      if (s.domain) {
        const d = document.createElement('div');
        d.className  = 'hng-domain';
        d.textContent = s.domain;
        body.appendChild(d);
      }

      const meta = document.createElement('div');
      meta.className = 'hng-meta';

      if (s.points) {
        const pt = document.createElement('span');
        pt.className = 'hng-pts'; pt.textContent = s.points; meta.appendChild(pt);
      }
      if (s.age) {
        const ag = document.createElement('span');
        ag.className = 'hng-age'; ag.textContent = s.age; meta.appendChild(ag);
      }

      const cmtA = document.createElement('a');
      cmtA.className = 'hng-cmt';
      cmtA.href      = s.cmtHref;
      cmtA.target    = '_blank';
      cmtA.rel       = 'noopener noreferrer';
      cmtA.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg> ${s.cmtText}`;
      cmtA.addEventListener('click', e => e.stopPropagation());
      meta.appendChild(cmtA);

      body.appendChild(meta);
      card.appendChild(body);
      grid.appendChild(card);
    });

    return grid;
  }

  // ── Favicon injection — must run AFTER grid is in the DOM ───────────────────
  // GM_addElement creates elements outside HN's CSP restrictions.
  // Requires an ATTACHED parent node — that's why this runs post-DOM-insertion.
  function addFavicons(grid) {
    grid.querySelectorAll('.hng-fallback[data-favicon-url]').forEach(fb => {
      const url = fb.dataset.faviconUrl;
      delete fb.dataset.faviconUrl;
      const fi = GM_addElement(fb, 'img', { src: url, alt: '' });
      fi.style.cssText = 'width:44px;height:44px;border-radius:8px;';
      fi.onerror = () => fi.remove();
      fb.insertBefore(fi, fb.firstChild); // icon before the domain text span
    });
  }

  // ── Lazy thumbnail loader ─────────────────────────────────────────────────
  // Observes .hng-thumb[data-page-url] divs (marked in buildCards).
  // After fetch, inserts img via GM_addElement — bypasses HN's img-src CSP.
  // The parent .hng-thumb is already in the DOM at this point, so GM_addElement works.
  function initThumbLoader(grid) {
    let active = 0;
    const queue = [];

    function drain() {
      if (active >= 3 || !queue.length) return;
      const { thumb, url } = queue.shift();
      active++;
      getThumb(url).then(srcUrl => {
        active--;
        if (srcUrl) {
          const fb = thumb.querySelector('.hng-fallback');
          // GM_addElement: bypasses HN's img-src CSP (uses extension CSP instead).
          // referrerpolicy="no-referrer": browser omits Referer header → hotlink protection bypassed.
          // Both problems solved with a plain https:// URL — no blob conversion needed.
          const img = GM_addElement(thumb, 'img', {
            src:             srcUrl,
            class:           'hng-thumb-img',
            alt:             '',
            referrerpolicy:  'no-referrer',
          });
          thumb.insertBefore(img, fb);
          img.addEventListener('load',  () => { img.classList.add('ready');  if (fb) fb.classList.add('gone'); });
          img.addEventListener('error', () => { img.classList.add('failed'); });
        }
        drain();
      }).catch(() => { active--; drain(); });
    }

    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const card  = e.target;
        const thumb = card.querySelector('.hng-thumb[data-page-url]');
        if (!thumb) return;
        io.unobserve(card);
        const url = thumb.dataset.pageUrl;
        delete thumb.dataset.pageUrl;
        queue.push({ thumb, url });
        drain();
      });
    }, { rootMargin: '400px' });

    grid.querySelectorAll('.hng-card').forEach(c => {
      if (c.querySelector('.hng-thumb[data-page-url]')) io.observe(c);
    });
  }

  // ── Split pane ────────────────────────────────────────────────────────────
  function buildSplit() {
    const el = document.createElement('div');
    el.id = 'hng-split';
    el.innerHTML = `
      <div id="hng-sbar">
        <span id="hng-stitle"></span>
        <button class="hng-sbtn" id="hng-swap">⇄ Swap</button>
        <button class="hng-sbtn" id="hng-close">✕ Close</button>
      </div>
      <div id="hng-spanes">
        <div class="hng-pane" id="hng-part">
          <div class="hng-plabel">
            🔗 Article
            <a id="hng-aext" href="#" target="_blank" rel="noopener">Open in new tab ↗</a>
          </div>
          <div id="hng-art-loading"><div class="hng-spinner"></div>Loading…</div>
          <iframe id="hng-iframe-art"></iframe>
        </div>
        <div id="hng-handle"></div>
        <div class="hng-pane" id="hng-pcmt">
          <div class="hng-plabel">
            💬 HN Comments
            <a id="hng-cext" href="#" target="_blank" rel="noopener">Open in new tab ↗</a>
          </div>
          <iframe id="hng-iframe-cmt"></iframe>
        </div>
      </div>
    `;
    document.body.appendChild(el);
  }

  function initSplit() {
    const overlay  = document.getElementById('hng-split');
    const iArt     = document.getElementById('hng-iframe-art');
    const iCmt     = document.getElementById('hng-iframe-cmt');
    const titleEl  = document.getElementById('hng-stitle');
    const aExt     = document.getElementById('hng-aext');
    const cExt     = document.getElementById('hng-cext');
    const pArt     = document.getElementById('hng-part');
    const pCmt     = document.getElementById('hng-pcmt');
    const panesEl  = document.getElementById('hng-spanes');
    const handle   = document.getElementById('hng-handle');
    const loadEl   = document.getElementById('hng-art-loading');

    // ── RIGHT PANE ONLY: 140% font into HN comments iframe ──────────────────
    iCmt.addEventListener('load', () => {
      if (!iCmt.src || !iCmt.src.includes('ycombinator.com')) return;
      try {
        const doc = iCmt.contentDocument;
        if (!doc || !doc.head) return;
        let s = doc.getElementById('hng-cmt-zoom');
        if (!s) {
          s = doc.createElement('style');
          s.id = 'hng-cmt-zoom';
          doc.head.appendChild(s);
        }
        s.textContent = `
          body                                     { font-size:140% !important; }
          .comment, .commtext, td.default, .ind    { font-size:100% !important;
                                                     line-height:1.65 !important; }
        `;
      } catch (_) {}
    });

    // ── LEFT PANE: load article ──────────────────────────────────────────────
    function loadArticle(url) {
      loadEl.classList.add('show');
      iArt.style.visibility = 'hidden';

      if (url.includes('news.ycombinator.com')) {
        iArt.removeAttribute('srcdoc');
        iArt.src = url;
        const onLoad = () => {
          iArt.removeEventListener('load', onLoad);
          loadEl.classList.remove('show');
          iArt.style.visibility = '';
        };
        iArt.addEventListener('load', onLoad);
        return;
      }

      // srcdoc bypasses X-Frame-Options. But HN's CSP default-src 'self' blocks
      // external stylesheets even inside srcdoc iframes. Fix: fetch each stylesheet
      // via GM and inline it as a <style> tag so CSP never sees the external request.
      gmFetch(url).then(async r => {
        let html = r.responseText || '';
        const base = r.finalUrl || url;

        // <base> for relative asset URLs (images, scripts, links)
        const baseTag = `<base href="${base}" target="_blank">`;
        html = /<head\b/i.test(html)
          ? html.replace(/(<head\b[^>]*>)/i, `$1\n${baseTag}`)
          : baseTag + html;

        // Find all <link rel="stylesheet" href="..."> tags
        const linkRe = /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi;
        const hrefRe = /\bhref=["']([^"']+)["']/i;
        const sheets = [];
        let m;
        while ((m = linkRe.exec(html)) !== null) {
          const hm = m[0].match(hrefRe);
          if (hm) {
            try { sheets.push({ tag: m[0], cssUrl: new URL(hm[1], base).href }); } catch(_) {}
          }
        }

        // Fetch each stylesheet via GM (bypasses CORS & CSP) and inline as <style>
        await Promise.all(sheets.map(async ({ tag, cssUrl }) => {
          try {
            const cr = await gmFetch(cssUrl);
            if (cr.status >= 200 && cr.status < 400 && cr.responseText) {
              // Rewrite relative url() paths inside the CSS to absolute
              const cssText = cr.responseText.replace(
                /url\(\s*["']?(?!data:|https?:|[/][/])([^"')]+)["']?\s*\)/gi,
                (_, p) => { try { return 'url("' + new URL(p, cssUrl).href + '")'; } catch(_) { return _; } }
              );
              html = html.replace(tag, `<style>\n${cssText}\n</style>`);
            }
          } catch(_) {}
        }));

        // Minimal layout fix — only html/body, never wildcard
        const narrowFix = `<style>html,body{max-width:100%!important;overflow-x:hidden!important}</style>`;
        html = /<\/head>/i.test(html)
          ? html.replace(/<\/head>/i, narrowFix + '</head>')
          : html + narrowFix;

        iArt.removeAttribute('src');
        iArt.srcdoc = html;

        const onLoad = () => {
          iArt.removeEventListener('load', onLoad);
          loadEl.classList.remove('show');
          iArt.style.visibility = '';
        };
        iArt.addEventListener('load', onLoad);
      }).catch(() => {
        loadEl.classList.remove('show');
        iArt.style.visibility = '';
        iArt.srcdoc = `<!DOCTYPE html><html><body style="font-family:Verdana,sans-serif;padding:40px;color:#555;text-align:center">
          <p style="font-size:14px;margin-bottom:16px">Couldn't load this page inline.</p>
          <a href="${url}" target="_blank" rel="noopener" style="color:#ff6600;font-size:13px;font-weight:bold">Open in new tab ↗</a>
        </body></html>`;
      });
    }

    function openSplit(artUrl, cmtUrl, title) {
      titleEl.textContent = title;
      aExt.href = artUrl;
      cExt.href = cmtUrl;
      iCmt.src  = cmtUrl;
      loadArticle(artUrl);
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    function closeSplit() {
      overlay.classList.remove('open');
      iArt.removeAttribute('srcdoc');
      iArt.src = 'about:blank';
      iCmt.src = 'about:blank';
      loadEl.classList.remove('show');
      iArt.style.visibility = '';
      document.body.style.overflow = '';
    }

    document.getElementById('hng-close').addEventListener('click', closeSplit);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeSplit();
    });

    let swapped = false;
    document.getElementById('hng-swap').addEventListener('click', () => {
      swapped = !swapped;
      if (swapped) panesEl.insertBefore(pCmt, pArt);
      else         panesEl.insertBefore(pArt, pCmt);
    });

    let dragging = false, sx = 0, sw = 0;
    handle.addEventListener('mousedown', e => {
      dragging = true; sx = e.clientX;
      sw = pArt.getBoundingClientRect().width;
      handle.classList.add('on'); e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const total = panesEl.getBoundingClientRect().width - handle.offsetWidth;
      const nw = Math.min(Math.max(sw + (e.clientX - sx), total * 0.2), total * 0.8);
      pArt.style.flex  = 'none';
      pArt.style.width = nw + 'px';
      pCmt.style.flex  = '1';
    });
    document.addEventListener('mouseup', () => { dragging = false; handle.classList.remove('on'); });

    return openSplit;
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  function init() {
    const stories = parseStories();
    if (!stories.length) return;

    injectStyles();

    const bar = document.createElement('div');
    bar.id = 'hng-bar';
    bar.innerHTML = `
      <a class="hng-logo" href="/">Y</a>
      <nav>
        <a href="/newest">new</a>
        <a href="/front">past</a>
        <a href="/newcomments">comments</a>
        <a href="/ask">ask</a>
        <a href="/show">show</a>
        <a href="/jobs">jobs</a>
        <a href="/submit">submit</a>
      </nav>
      <form id="hng-search-form">
        <input id="hng-search-input" type="search" placeholder="Search HN…" autocomplete="off">
        <button id="hng-search-btn" type="submit">Search</button>
      </form>
      <button id="hng-toggle">☰ List view</button>
    `;
    document.body.insertBefore(bar, document.body.firstChild);

    const grid = buildCards(stories);

    const moreDiv = document.createElement('div');
    moreDiv.id = 'hng-more';
    const moreA = document.querySelector('a.morelink');
    if (moreA) moreDiv.innerHTML = `<a href="${moreA.href}">More stories →</a>`;

    const footer = document.createElement('div');
    footer.id = 'hng-footer';
    footer.innerHTML = [
      ['Guidelines','/newsguidelines.html'],
      ['FAQ','/newsfaq.html'],
      ['API','https://github.com/HackerNews/API'],
      ['Security','/security.html'],
    ].map(([t, h]) => `<a href="${h}">${t}</a>`).join(' | ');

    const wrapper = document.createElement('div');
    wrapper.id = 'hng-wrapper';
    [grid, moreDiv, footer].forEach(el => wrapper.appendChild(el));
    bar.insertAdjacentElement('afterend', wrapper);

    const hnmain = document.getElementById('hnmain');
    if (hnmain) hnmain.style.display = 'none';

    // Grid is now in the DOM — safe to use GM_addElement on its children
    addFavicons(grid);
    initThumbLoader(grid);

    buildSplit();
    const openSplit = initSplit();

    grid.addEventListener('click', e => {
      if (e.target.closest('.hng-cmt')) return;
      const card = e.target.closest('.hng-card');
      if (!card) return;
      const isHN   = !!card.dataset.isHN;
      const artUrl = isHN ? card.dataset.cmt : card.dataset.url;
      openSplit(artUrl, card.dataset.cmt, card.dataset.title);
    });

    let gridMode = true;
    document.getElementById('hng-toggle').addEventListener('click', () => {
      gridMode = !gridMode;
      const btn = document.getElementById('hng-toggle');
      if (gridMode) {
        wrapper.style.display = '';
        if (hnmain) hnmain.style.display = 'none';
        btn.textContent = '☰ List view';
      } else {
        wrapper.style.display = 'none';
        if (hnmain) hnmain.style.display = '';
        btn.textContent = '⊞ Grid view';
      }
    });

    // Search — opens HN Algolia search in new tab
    document.getElementById('hng-search-form').addEventListener('submit', e => {
      e.preventDefault();
      const q = document.getElementById('hng-search-input').value.trim();
      if (q) window.open('https://hn.algolia.com/?q=' + encodeURIComponent(q), '_blank');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();