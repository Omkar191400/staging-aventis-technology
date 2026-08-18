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

async function main() {
  const fileArgIdx = process.argv.indexOf('--file');
  let xml;

  if (fileArgIdx !== -1) {
    xml = fs.readFileSync(process.argv[fileArgIdx + 1], 'utf8');
    console.log(`[generate-blog] Using local fixture: ${process.argv[fileArgIdx + 1]}`);
  } else {
    console.log(`[generate-blog] Fetching ${FEED_URL} ...`);
    const res = await fetch(FEED_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AventisBlogBot/1.0)' }
    });
    if (!res.ok) {
      throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
    }
    xml = await res.text();
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
  console.error('[generate-blog] Failed:', err.message);
  // Fail soft: if the feed is unreachable at build time, ship the page
  // with the empty state rather than breaking the whole site build.
  try {
    const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const output = template.replace('<!--POSTS-->', emptyStateHTML());
    fs.writeFileSync(OUTPUT_PATH, output);
    console.log('[generate-blog] Wrote fallback blog.html with empty state.');
  } catch (e2) {
    console.error('[generate-blog] Could not write fallback either:', e2.message);
    process.exit(1);
  }
});
