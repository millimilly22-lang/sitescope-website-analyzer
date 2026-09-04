import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../dist')
const base = await readFile(path.join(dist, 'index.html'), 'utf8')
const routes = [
  ['/', 'SiteScope — Free Website Structure Analyzer', 'Analyze a public website URL and organize pages, navigation, headings, links, images and metadata.', 'See how a website is structured in seconds.'],
  ['/website-analyzer', 'Website Analyzer — Site Structure, Pages & Links | SiteScope', 'Paste a URL to inspect public pages, navigation, headings, links, images and metadata.', 'Analyze a website and see what is inside.'],
  ['/website-structure-analyzer', 'Website Structure Analyzer | SiteScope', 'Map public pages, navigation and headings from a website URL.', 'Map a website structure from one URL.'],
  ['/website-link-analyzer', 'Website Link Analyzer | SiteScope', 'Find internal and external links from public website pages.', 'Find website links and put them in order.'],
  ['/how-it-works', 'How SiteScope Works', 'Learn how SiteScope crawls permitted public website pages and organizes the result.', 'How SiteScope website analysis works.'],
  ['/faq', 'Website Analyzer FAQ | SiteScope', 'Common questions about SiteScope website crawling and analysis.', 'Website analyzer FAQ.'],
  ['/privacy', 'Privacy Policy | SiteScope', 'Read the SiteScope privacy policy.', 'Privacy Policy'],
  ['/terms', 'Terms of Use | SiteScope', 'Read the SiteScope terms of use.', 'Terms of Use']
]

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
for (const [route,title,description,h1] of routes) {
  const canonical = `__SITE_ORIGIN__${route}`
  const staticHtml = `<div class="seo-fallback"><header><a href="/">SiteScope</a><nav><a href="/website-analyzer">Analyzer</a> <a href="/how-it-works">How it works</a> <a href="/faq">FAQ</a></nav></header><main><h1>${esc(h1)}</h1><p>${esc(description)}</p><p><a href="/website-analyzer">Open website analyzer</a></p></main></div>`
  const schema = JSON.stringify({'@context':'https://schema.org','@type':route==='/website-analyzer'?'WebApplication':'WebPage','name':title,'description':description,'url':canonical})
  let html = base
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${esc(description)}" />`)
    .replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${canonical}" />`)
    .replace('</head>', `<script type="application/ld+json">${schema}</script></head>`)
    .replace('<div id="root"></div>', `<div id="root">${staticHtml}</div>`)
  const dir = route === '/' ? dist : path.join(dist, route.slice(1))
  await mkdir(dir,{recursive:true})
  await writeFile(path.join(dir,'index.html'), html)
}
console.log(`Prerendered ${routes.length} SEO pages`)
