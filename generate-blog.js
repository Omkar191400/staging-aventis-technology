// generate-blog.js
// Fetches the Aventis Medium RSS feed at build time and writes blog.html
// with real post cards, styled to match the rest of the site.
//
// Runs with plain Node (18+) — no npm dependencies. Cloudflare Pages'
// build command should be:  node generate-blog.js
//
// Usage locally:  node generate-blog.js
// Usage against a local test fixture:  node generate-blog.js --file ./test-feed.xml

const fs = require('fs');
const path = require('path');

const FEED_URL = process.env.MEDIUM_FEED_URL || 'https://medium.com/feed/@vamsi.reddy_43948';
const TEMPLATE_PATH = path.join(__dirname, 'blog.template.html');
const OUTPUT_PATH = path.join(__dirname, 'blog.html');
const MAX_POSTS = 9;

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extract(tag, block) {
  // handles both <tag>...</tag> and <tag><![CDATA[...]]></tag>
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) val = cdata[1];
  return val;
}

function firstImage(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function formatDate(pubDate) {
  try {
    const d = new Date(pubDate);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) {
    return '';
  }
}

function excerpt(text, maxLen = 140) {
  const clean = stripTags(text);
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

function parseItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = decodeEntities(extract('title', block));
    const link = extract('link', block).split('?')[0]; // strip Medium tracking params
    const pubDate = extract('pubDate', block);
    const category = decodeEntities(extract('category', block));
    const contentEncoded = extract('content:encoded', block) || extract('description', block);
    const img = firstImage(contentEncoded);
    const desc = excerpt(contentEncoded);
    items.push({ title, link, pubDate, category, img, desc });
  }
  return items;
}

function cardHTML(post) {
  const dateLabel = formatDate(post.pubDate);
  const tag = post.category ? post.category : 'Article';
  const thumb = post.img
    ? `<div class="thumb"><img src="${post.img}" alt="" loading="lazy"></div>`
    : '';
  return `      <a class="bpost" href="${post.link}" target="_blank" rel="noopener">
        ${thumb}
        <div class="body">
          <span class="meta">${tag}${dateLabel ? ' &middot; ' + dateLabel : ''}</span>
          <h3>${post.title}</h3>
          <p>${post.desc}</p>
        </div>
      </a>`;
}

function emptyStateHTML() {
  return `    <div class="blog-empty rv">
      <p>New posts are on the way. In the meantime, follow along on <a href="${FEED_URL.replace('/feed/', '/')}" target="_blank" rel="noopener" style="color:var(--blue)">Medium</a>.</p>
    </div>`;
}

// ── Fetch with timeout + retry ────────────────────────────────────────────────
const FETCH_TIMEOUT_MS  = 10_000;   // 10 s per attempt
const RETRY_ATTEMPTS    = 3;        // total tries (1 original + 2 retries)
const RETRY_BASE_MS     = 1_500;    // backoff base: 1.5 s, 3 s, 6 s …

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeedWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      console.log(`[generate-blog] Fetch attempt ${attempt}/${RETRY_ATTEMPTS} — ${url}`);
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AventisBlogBot/1.0)' }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const xml = await res.text();
      if (!xml.includes('<item>')) {
        throw new Error('Response received but no <item> elements found — possibly not a valid RSS feed');
      }
      return xml;
    } catch (err) {
      lastErr = err;
      const isAbort = err.name === 'AbortError';
      console.warn(`[generate-blog] Attempt ${attempt} failed: ${isAbort ? `timed out after ${FETCH_TIMEOUT_MS}ms` : err.message}`);
      if (attempt < RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(`[generate-blog] Retrying in ${delay}ms …`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Fallback: keep existing blog.html if Medium is unreachable ────────────────
function writeFallback() {
  // If a previous successful build left a blog.html, keep it — stale posts
  // are better than an empty page. Only write the empty state if there is
  // nothing at all.
  if (fs.existsSync(OUTPUT_PATH)) {
    console.log('[generate-blog] Medium unreachable — keeping existing blog.html (stale-ok).');
    return;
  }
  try {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const output = template.replace('<!--POSTS-->', emptyStateHTML());
    fs.writeFileSync(OUTPUT_PATH, output);
    console.log('[generate-blog] No existing blog.html — wrote empty-state fallback.');
  } catch (e2) {
    console.error('[generate-blog] Could not write fallback either:', e2.message);
    // Still exit 0 so the rest of the site build completes.
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const fileArgIdx = process.argv.indexOf('--file');
  let xml;

  if (fileArgIdx !== -1) {
    const fixturePath = process.argv[fileArgIdx + 1];
    xml = fs.readFileSync(fixturePath, 'utf8');
    console.log(`[generate-blog] Using local fixture: ${fixturePath}`);
  } else {
    xml = await fetchFeedWithRetry(FEED_URL);
    console.log('[generate-blog] Feed fetched successfully.');
  }

  const items = parseItems(xml).slice(0, MAX_POSTS);
  console.log(`[generate-blog] Parsed ${items.length} post(s).`);

  const gridInner = items.length
    ? `    <div class="blog-grid rv">\n${items.map(cardHTML).join('\n')}\n    </div>`
    : emptyStateHTML();

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const output = template.replace('<!--POSTS-->', gridInner);
  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`[generate-blog] Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('[generate-blog] All fetch attempts failed:', err.message);
  writeFallback();
  // Exit 0 — feed being down should never break a site deploy.
  process.exit(0);
});
