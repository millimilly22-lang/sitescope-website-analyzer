import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '../dist')
const base = await readFile(path.join(dist, 'index.html'), 'utf8')
const routes = [
  ['/', 'SiteScope — Universal Public Link Analyzer', 'Analyze public websites, product pages, articles and PDF links. Render important pages, organize images, links, content, SEO and technical signals.', 'Analyze public links and see what is really inside.'],
  ['/website-analyzer', 'Website Analyzer — Rendered Pages, Images, SEO & Structure | SiteScope', 'Paste a public website URL to inspect rendered sections, pages, headings, links, images, products, media and SEO signals.', 'Analyze a website and organize the important information.'],
  ['/website-structure-analyzer', 'Website Structure Analyzer | SiteScope', 'Map public website pages, navigation, headings, visual sections and internal structure from one URL.', 'Map a website structure from one URL.'],
  ['/website-link-analyzer', 'Website Link Analyzer — Internal, External & PDF Links | SiteScope', 'Find and organize public internal links, external links, PDF links, navigation and social URLs.', 'Find website links and put them in order.'],
  ['/pdf-link-analyzer', 'PDF Link Analyzer — Read Public PDF URLs | SiteScope', 'Paste a public PDF URL to extract document metadata, headings, page count, links and text preview.', 'Analyze a public PDF link.'],
  ['/product-page-analyzer', 'Product Page Analyzer — Price, Images & Product Data | SiteScope', 'Analyze public product pages for product schema, prices, brand, images, CTAs and page structure.', 'Analyze product page information.'],
  ['/article-analyzer', 'Article Analyzer — Headings, Author, Links & Images | SiteScope', 'Analyze public article and blog links for metadata, headings, images, links, author/date signals and structure.', 'Analyze a public article link.'],
  ['/compare-websites', 'Compare Websites Side by Side | SiteScope', 'Compare two public websites by pages, images, words, products, pricing, technologies and SEO signals.', 'Compare two public websites.'],
  ['/website-change-monitor', 'Website Change Checker | SiteScope', 'Save a website snapshot in your browser and compare later scans for page and content changes.', 'Check what changed on a website.'],
  ['/how-it-works', 'How SiteScope Works', 'Learn how SiteScope safely crawls public pages, attempts browser rendering and organizes link intelligence.', 'How SiteScope link analysis works.'],
  ['/faq', 'SiteScope FAQ | Public Link Analyzer', 'Common questions about SiteScope website crawling, browser rendering, PDFs, comparison and change checking.', 'SiteScope FAQ.'],
  ['/privacy', 'Privacy Policy | SiteScope', 'Read the SiteScope privacy policy.', 'Privacy Policy'],
  ['/terms', 'Terms of Use | SiteScope', 'Read the SiteScope terms of use.', 'Terms of Use']
]
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
for(const [route,title,description,h1] of routes){
 const canonical=`__SITE_ORIGIN__${route}`
 const staticHtml=`<div class="seo-fallback"><header><a href="/">SiteScope</a><nav><a href="/website-analyzer">Analyze</a> <a href="/compare-websites">Compare</a> <a href="/website-change-monitor">Changes</a> <a href="/faq">FAQ</a></nav></header><main><h1>${esc(h1)}</h1><p>${esc(description)}</p><p><a href="/website-analyzer">Open public link analyzer</a></p></main></div>`
 const type=['/website-analyzer','/pdf-link-analyzer','/product-page-analyzer','/article-analyzer','/compare-websites','/website-change-monitor'].includes(route)?'WebApplication':'WebPage'
 const schema=JSON.stringify({'@context':'https://schema.org','@type':type,'name':title,'description':description,'url':canonical,'isAccessibleForFree':true})
 let html=base.replace(/<title>[\s\S]*?<\/title>/i,`<title>${esc(title)}</title>`).replace(/<meta name="description"[^>]*>/i,`<meta name="description" content="${esc(description)}" />`).replace(/<link rel="canonical"[^>]*>/i,`<link rel="canonical" href="${canonical}" />`).replace('</head>',`<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/><meta property="og:type" content="website"/><meta property="og:url" content="${canonical}"/><script type="application/ld+json">${schema}</script></head>`).replace('<div id="root"></div>',`<div id="root">${staticHtml}</div>`)
 const dir=route==='/'?dist:path.join(dist,route.slice(1));await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'index.html'),html)
}
console.log(`Prerendered ${routes.length} SEO pages`)
