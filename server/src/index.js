import express from 'express'
import * as cheerio from 'cheerio'
import ipaddr from 'ipaddr.js'
import robotsParser from 'robots-parser'
import dns from 'node:dns/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import pdfParse from 'pdf-parse'

const app = express()
const PORT = process.env.PORT || 8787
const USER_AGENT = 'SiteScopeBot/2.0 (+public website analysis)'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(__dirname, '../../client/dist')
const MAX_HTML_BYTES = 4_000_000
const MAX_PDF_BYTES = 20_000_000
const browserSlots = { active: 0, max: 1 }

app.set('trust proxy', 1)
app.use(express.json({ limit: '250kb' }))

const buckets = new Map()
app.use('/api/', (req, res, next) => {
  if (req.path === '/health') return next()
  const key = req.ip || 'unknown'
  const now = Date.now()
  const b = buckets.get(key) || { start: now, count: 0 }
  if (now - b.start > 3_600_000) { b.start = now; b.count = 0 }
  b.count += 1
  buckets.set(key, b)
  if (b.count > 40) return res.status(429).json({ error: 'Too many requests. Please try again later.' })
  next()
})

function cleanText(s = '') { return String(s).replace(/\s+/g, ' ').trim() }
function uniq(arr) { return [...new Set(arr.filter(Boolean))] }
function uniqueObjects(arr, key = 'url') {
  const seen = new Set()
  return arr.filter(x => { const k = x?.[key] || JSON.stringify(x); if (!k || seen.has(k)) return false; seen.add(k); return true })
}
function limitText(s = '', n = 1200) { const t = cleanText(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
function normalizeInput(v) {
  if (!v || typeof v !== 'string') throw new Error('Enter a public URL.')
  let s = v.trim()
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  const u = new URL(s)
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.')
  u.username = ''; u.password = ''
  return u
}
function privateIp(address) {
  try { return ipaddr.parse(address).range() !== 'unicast' } catch { return true }
}
async function assertPublic(url) {
  const u = url instanceof URL ? url : new URL(url)
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Local/private network addresses are not allowed.')
  if (ipaddr.isValid(host) && privateIp(host)) throw new Error('Local/private network addresses are not allowed.')
  const records = await dns.lookup(host, { all: true })
  if (!records.length || records.some(r => privateIp(r.address))) throw new Error('Local/private network addresses are not allowed.')
}
async function safeFetch(input, opts = {}) {
  let u = input instanceof URL ? new URL(input) : new URL(input)
  for (let i = 0; i < 5; i += 1) {
    await assertPublic(u)
    const c = new AbortController()
    const timer = setTimeout(() => c.abort(), opts.timeout || 14_000)
    let r
    try {
      r = await fetch(u, {
        method: opts.method || 'GET', redirect: 'manual', signal: c.signal,
        headers: { 'user-agent': USER_AGENT, accept: opts.accept || 'text/html,application/xhtml+xml,application/pdf,text/plain;q=.8,*/*;q=.2', ...(opts.headers || {}) }
      })
    } finally { clearTimeout(timer) }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location')
      if (!loc) throw new Error('Invalid redirect.')
      u = new URL(loc, u); continue
    }
    return { response: r, url: u }
  }
  throw new Error('Too many redirects.')
}
async function readTextLimited(response, maxBytes = MAX_HTML_BYTES) {
  const len = Number(response.headers.get('content-length') || 0)
  if (len && len > maxBytes) throw new Error('Page is too large to analyze.')
  const reader = response.body?.getReader?.()
  if (!reader) return (await response.text()).slice(0, maxBytes)
  const chunks = []; let total = 0
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    total += value.byteLength
    if (total > maxBytes) { await reader.cancel(); throw new Error('Page is too large to analyze.') }
    chunks.push(value)
  }
  const all = new Uint8Array(total); let offset = 0
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(all)
}
async function readBufferLimited(response, maxBytes) {
  const len = Number(response.headers.get('content-length') || 0)
  if (len && len > maxBytes) throw new Error('File is too large to analyze.')
  const ab = await response.arrayBuffer()
  if (ab.byteLength > maxBytes) throw new Error('File is too large to analyze.')
  return Buffer.from(ab)
}
function absolute(href, base) {
  try { const u = new URL(href, base); if (!['http:', 'https:'].includes(u.protocol)) return null; u.hash = ''; return u.toString() } catch { return null }
}
function pageType(pathname) {
  const p = pathname.toLowerCase()
  if (p === '/' || !p) return 'home'
  if (/privacy|terms|policy|legal/.test(p)) return 'policy'
  if (/contact/.test(p)) return 'contact'
  if (/about|company|team/.test(p)) return 'about'
  if (/pricing|plans/.test(p)) return 'pricing'
  if (/blog|news|article|post/.test(p)) return 'article'
  if (/product|shop|store|item/.test(p)) return 'product'
  if (/service|solution/.test(p)) return 'service'
  return 'page'
}
function flattenJsonLd(value, out = []) {
  if (!value) return out
  if (Array.isArray(value)) { value.forEach(v => flattenJsonLd(v, out)); return out }
  if (typeof value === 'object') { if (value['@type']) out.push(value); if (value['@graph']) flattenJsonLd(value['@graph'], out) }
  return out
}
function parseJsonLd($) {
  const nodes = []
  $('script[type="application/ld+json"]').each((_, el) => { try { flattenJsonLd(JSON.parse($(el).html() || 'null'), nodes) } catch {} })
  return nodes
}
function typeList(node) { return Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']].filter(Boolean) }
function firstValue(v) {
  if (Array.isArray(v)) return firstValue(v[0])
  if (v && typeof v === 'object') return v.name || v.url || v['@id'] || ''
  return v == null ? '' : String(v)
}
function detectTechnologies(html, $) {
  const h = html.toLowerCase(), out = []
  const generator = cleanText($('meta[name="generator"]').attr('content') || '')
  if (generator) out.push(generator)
  const rules = [['WordPress',/wp-content|wp-includes/],['Shopify',/cdn\.shopify\.com|shopify-section/],['Wix',/wixstatic\.com|wix-code/],['Webflow',/webflow\.com|w-webflow/],['Next.js',/__next|_next\//],['Nuxt',/__nuxt|_nuxt\//],['React',/reactroot|data-reactroot/],['Squarespace',/squarespace/],['WooCommerce',/woocommerce/],['Google Analytics',/googletagmanager|google-analytics/],['Stripe',/stripe\.com|js\.stripe/],['Cloudflare',/cloudflare/]]
  for (const [name, re] of rules) if (re.test(h)) out.push(name)
  return uniq(out)
}
function imageKind(img, pageTitle = '') {
  const t = `${img.alt || ''} ${img.src || ''} ${img.className || ''}`.toLowerCase()
  if (/logo|brand/.test(t)) return 'logo'
  if (/hero|banner|cover/.test(t) || (img.width >= 900 && img.height >= 350)) return 'hero/banner'
  if (/product|item|shop/.test(t) || /product/i.test(pageTitle)) return 'product'
  if ((img.width && img.width <= 96) || /icon|avatar/.test(t)) return 'icon/avatar'
  return 'content'
}
function extractPage(html, url, origin, rendered = {}) {
  const $ = cheerio.load(html)
  const jsonLdNodes = parseJsonLd($)
  $('script:not([type="application/ld+json"]),style,noscript,template').remove()
  const internal = [], external = [], nav = [], emails = [], phones = [], socials = [], pdfLinks = [], rawLinks = []
  $('a[href]').each((_, el) => {
    const raw = cleanText($(el).attr('href') || ''), text = cleanText($(el).text()) || raw
    if (/^mailto:/i.test(raw)) { emails.push(raw.replace(/^mailto:/i, '').split('?')[0]); return }
    if (/^tel:/i.test(raw)) { phones.push(raw.replace(/^tel:/i, '').split('?')[0]); return }
    const href = absolute(raw, url); if (!href) return
    rawLinks.push({ text, url: href }); const u = new URL(href)
    if (u.origin === origin) internal.push(href); else external.push(href)
    if (/\.pdf(?:$|\?)/i.test(href)) pdfLinks.push(href)
    if (/facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|x\.com|twitter\.com/i.test(href)) socials.push(href)
    if ($(el).parents('nav,header').length && u.origin === origin) nav.push({ text, url: href })
  })
  const title = cleanText($('title').first().text())
  const description = cleanText($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '')
  const headings = { h1: $('h1').map((_,x)=>cleanText($(x).text())).get().filter(Boolean).slice(0,20), h2: $('h2').map((_,x)=>cleanText($(x).text())).get().filter(Boolean).slice(0,80), h3: $('h3').map((_,x)=>cleanText($(x).text())).get().filter(Boolean).slice(0,120) }
  const canonical = absolute($('link[rel="canonical"]').attr('href') || '', url)
  const bodyText = cleanText($('body').text())
  const summary = limitText(description || headings.h1[0] || title || bodyText, 500)
  const og = { title: cleanText($('meta[property="og:title"]').attr('content')||''), description: cleanText($('meta[property="og:description"]').attr('content')||''), image: absolute($('meta[property="og:image"]').attr('content')||'',url), type: cleanText($('meta[property="og:type"]').attr('content')||''), video: absolute($('meta[property="og:video"]').attr('content')||'',url) }
  const twitter = { card: cleanText($('meta[name="twitter:card"]').attr('content')||''), title: cleanText($('meta[name="twitter:title"]').attr('content')||''), image: absolute($('meta[name="twitter:image"]').attr('content')||'',url) }
  const domImages = []
  $('img').each((_,el)=>{const node=$(el);const src=absolute(node.attr('src')||node.attr('data-src')||node.attr('data-lazy-src')||'',url);if(!src)return;domImages.push({src,alt:cleanText(node.attr('alt')||''),width:Number(node.attr('width')||0),height:Number(node.attr('height')||0),className:cleanText(node.attr('class')||''),sourcePage:url})})
  if (og.image) domImages.push({src:og.image,alt:og.title||title,width:0,height:0,className:'og:image',sourcePage:url})
  const images = uniqueObjects([...(rendered.images||[]).map(i=>({...i,sourcePage:url})),...domImages],'src').map(i=>({...i,kind:imageKind(i,title)})).slice(0,250)
  const ctas = []
  $('button,a').each((_,el)=>{const text=cleanText($(el).text());if(!text||text.length>90)return;const cls=cleanText($(el).attr('class')||'').toLowerCase();const href=$(el).is('a')?absolute($(el).attr('href')||'',url):null;if(/buy|shop|start|get|try|sign|join|book|contact|download|subscribe|learn|demo|order|add to cart|checkout/i.test(text)||/btn|button|cta/.test(cls))ctas.push({text,url:href})})
  const forms = []
  $('form').each((_,el)=>{const f=$(el);forms.push({action:absolute(f.attr('action')||url,url)||url,method:(f.attr('method')||'get').toUpperCase(),fields:f.find('input,select,textarea').map((_,x)=>cleanText($(x).attr('name')||$(x).attr('placeholder')||$(x).attr('type')||'')).get().filter(Boolean).slice(0,20)})})
  const faqs = []
  $('details').each((_,el)=>{const q=cleanText($(el).find('summary').first().text()),a=limitText($(el).text().replace(q,''),600);if(q)faqs.push({question:q,answer:a})})
  $('h2,h3,h4').each((_,el)=>{const q=cleanText($(el).text());if(!q.endsWith('?'))return;faqs.push({question:q,answer:limitText($(el).next('p,div').text(),600)})})
  const prices = uniq((bodyText.match(/(?:[$€£¥]|USD|EUR|GBP|PLN|zł)\s?\d[\d.,]*(?:\s?(?:\/|per)\s?(?:month|mo|year|yr))?|\d[\d.,]*\s?(?:USD|EUR|GBP|PLN|zł)/gi)||[]).map(cleanText)).slice(0,40)
  const videos = []
  $('video').each((_,el)=>{const v=$(el),sources=[];const src=absolute(v.attr('src')||'',url);if(src)sources.push(src);v.find('source[src]').each((__,s)=>{const x=absolute($(s).attr('src')||'',url);if(x)sources.push(x)});const tracks=v.find('track[src]').map((__,t)=>({kind:$(t).attr('kind')||'',label:$(t).attr('label')||'',src:absolute($(t).attr('src')||'',url)})).get().filter(x=>x.src);videos.push({provider:'html5',url:sources[0]||url,sources:uniq(sources),poster:absolute(v.attr('poster')||'',url),tracks,sourcePage:url})})
  $('iframe[src]').each((_,el)=>{const src=absolute($(el).attr('src')||'',url);if(!src)return;let provider='';if(/youtube\.com|youtu\.be/.test(src))provider='youtube';else if(/vimeo\.com/.test(src))provider='vimeo';else if(/wistia|loom\.com|dailymotion/.test(src))provider='embedded';if(provider)videos.push({provider,url:src,sources:[src],poster:null,tracks:[],sourcePage:url})})
  if (og.video) videos.push({provider:'open-graph',url:og.video,sources:[og.video],poster:og.image,tracks:[],sourcePage:url})
  const products=[],articles=[]
  for(const node of jsonLdNodes){const types=typeList(node).map(String);if(types.some(t=>/Product/i.test(t))){const offer=Array.isArray(node.offers)?node.offers[0]:node.offers||{};products.push({name:firstValue(node.name),brand:firstValue(node.brand),sku:firstValue(node.sku),price:firstValue(offer.price||offer.lowPrice),currency:firstValue(offer.priceCurrency),availability:firstValue(offer.availability),image:firstValue(node.image),url:firstValue(node.url)||url,sourcePage:url})}if(types.some(t=>/Article|BlogPosting|NewsArticle/i.test(t)))articles.push({headline:firstValue(node.headline||node.name),author:firstValue(node.author),datePublished:firstValue(node.datePublished),dateModified:firstValue(node.dateModified),image:firstValue(node.image),url:firstValue(node.url||node.mainEntityOfPage)||url,sourcePage:url})}
  let detectedType=pageType(new URL(url).pathname);const allTypes=uniq(jsonLdNodes.flatMap(typeList).map(String));if(products.length||allTypes.some(t=>/Product/i.test(t))||/add to cart|buy now/i.test(bodyText))detectedType='product';else if(articles.length||allTypes.some(t=>/Article|BlogPosting|NewsArticle/i.test(t))||og.type==='article')detectedType='article';else if(videos.length&&/video/.test(og.type))detectedType='video'
  const missingAlt=images.filter(i=>!i.alt&&i.kind!=='icon/avatar').length,seoIssues=[]
  if(!title)seoIssues.push('Missing page title');if(!description)seoIssues.push('Missing meta description');if(!headings.h1.length)seoIssues.push('Missing H1 heading');if(headings.h1.length>1)seoIssues.push('Multiple H1 headings');if(!canonical)seoIssues.push('Canonical URL not declared');if(missingAlt)seoIssues.push(`${missingAlt} important images missing alt text`)
  return {url,title,description,summary,language:$('html').attr('lang')||'',canonical,type:detectedType,wordCount:bodyText?bodyText.split(/\s+/).length:0,headings,ctas:uniqueObjects(ctas,'text').slice(0,40),prices,forms,faqs:uniqueObjects(faqs,'question').slice(0,30),internalLinks:uniq(internal),externalLinks:uniq(external),links:rawLinks.slice(0,250),pdfLinks:uniq(pdfLinks),contacts:{emails:uniq(emails),phones:uniq(phones),socials:uniq(socials)},navigation:uniqueObjects(nav,'url').slice(0,80),images,videos:uniqueObjects(videos,'url'),products,articles,structuredDataTypes:allTypes,technologies:detectTechnologies(html,$),openGraph:og,twitter,seoIssues,rendered:Boolean(rendered.rendered),sections:rendered.sections||[],viewport:rendered.viewport||null}
}

async function maybeLaunchBrowser(){
  if(browserSlots.active>=browserSlots.max)return null
  browserSlots.active+=1
  try{const[{default:puppeteer},{default:chromium}]=await Promise.all([import('puppeteer-core'),import('@sparticuz/chromium')]);const executablePath=await chromium.executablePath();return await puppeteer.launch({executablePath,args:chromium.args,headless:true,defaultViewport:{width:1280,height:900,deviceScaleFactor:1}})}catch(e){browserSlots.active=Math.max(0,browserSlots.active-1);console.warn('Browser rendering unavailable:',e.message);return null}
}
async function closeBrowser(browser){if(!browser)return;try{await browser.close()}catch{}browserSlots.active=Math.max(0,browserSlots.active-1)}
async function renderPage(browser,url,withScreenshot=false){
  if(!browser)return null
  await assertPublic(url);const page=await browser.newPage();await page.setRequestInterception(true)
  page.on('request',async req=>{try{const ru=new URL(req.url());if(!['http:','https:','data:','blob:'].includes(ru.protocol))return req.abort();if(['data:','blob:'].includes(ru.protocol))return req.continue();if(req.resourceType()==='media')return req.abort();await assertPublic(ru);return req.continue()}catch{return req.abort()}})
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:18000});await new Promise(r=>setTimeout(r,900));await page.evaluate(async()=>{const step=Math.max(500,window.innerHeight*.8);for(let y=0;y<Math.min(document.body.scrollHeight,5000);y+=step){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,90))}window.scrollTo(0,0)}).catch(()=>{});const rendered=await page.evaluate(()=>{const text=el=>(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();const images=[...document.images].map(img=>({src:img.currentSrc||img.src,alt:img.alt||'',width:img.naturalWidth||img.width||0,height:img.naturalHeight||img.height||0,className:img.className||''})).filter(x=>/^https?:/i.test(x.src));const sections=[...document.querySelectorAll('main section, main article, section, article')].map((el,i)=>{const r=el.getBoundingClientRect(),heading=el.querySelector('h1,h2,h3');return{index:i+1,tag:el.tagName.toLowerCase(),heading:text(heading),text:text(el).slice(0,700),y:Math.round(r.top+window.scrollY),height:Math.round(r.height)}}).filter(x=>x.text.length>40&&x.height>20).slice(0,40);return{rendered:true,images,sections,viewport:{width:window.innerWidth,height:window.innerHeight,pageHeight:document.documentElement.scrollHeight}}});const html=await page.content();let screenshot=null;if(withScreenshot){const dims=await page.evaluate(()=>({w:Math.min(1280,document.documentElement.scrollWidth||1280),h:Math.min(2600,document.documentElement.scrollHeight||900)}));const buf=await page.screenshot({type:'jpeg',quality:55,clip:{x:0,y:0,width:Math.max(320,dims.w),height:Math.max(300,dims.h)},captureBeyondViewport:true});screenshot=`data:image/jpeg;base64,${buf.toString('base64')}`}return{html,rendered,screenshot,finalUrl:page.url()}}finally{await page.close().catch(()=>{})}
}
async function fetchHtmlPage(url){const{response,url:finalUrl}=await safeFetch(url);if(!response.ok)throw new Error(`HTTP ${response.status}`);const ct=(response.headers.get('content-type')||'').toLowerCase();if(!ct.includes('text/html')&&!ct.includes('application/xhtml+xml'))throw new Error('Not an HTML page');return{html:await readTextLimited(response),finalUrl:finalUrl.toString()}}
async function loadPage(url,origin,browser,renderedWanted=false,withScreenshot=false){if(renderedWanted&&browser){try{const r=await renderPage(browser,url,withScreenshot);if(r)return{page:extractPage(r.html,r.finalUrl,origin,r.rendered),screenshot:r.screenshot}}catch(e){console.warn('Rendered page failed; falling back:',e.message)}}const r=await fetchHtmlPage(url);return{page:extractPage(r.html,r.finalUrl,origin,{}),screenshot:null}}
function groupReport(pages){const home=pages[0],features=uniq(pages.flatMap(p=>[...p.headings.h2,...p.headings.h3]).filter(x=>/feature|benefit|why|what you get|capabilit|service|solution/i.test(x))).slice(0,30),pricing=uniq(pages.flatMap(p=>p.prices)).slice(0,40),ctas=uniqueObjects(pages.flatMap(p=>p.ctas),'text').slice(0,50),faqs=uniqueObjects(pages.flatMap(p=>p.faqs),'question').slice(0,40),products=uniqueObjects(pages.flatMap(p=>p.products),'name').slice(0,60),articles=uniqueObjects(pages.flatMap(p=>p.articles),'url').slice(0,60),videos=uniqueObjects(pages.flatMap(p=>p.videos),'url').slice(0,60),pdfs=uniq(pages.flatMap(p=>p.pdfLinks)).slice(0,100),images=uniqueObjects(pages.flatMap(p=>p.images),'src').slice(0,400),policies=uniqueObjects(pages.flatMap(p=>p.links).filter(l=>/privacy|terms|refund|shipping|cookie|policy/i.test(`${l.text} ${l.url}`)),'url').slice(0,40),contacts={emails:uniq(pages.flatMap(p=>p.contacts.emails)),phones:uniq(pages.flatMap(p=>p.contacts.phones)),socials:uniq(pages.flatMap(p=>p.contacts.socials))},technologies=uniq(pages.flatMap(p=>p.technologies)),seoIssues=pages.flatMap(p=>p.seoIssues.map(issue=>({page:p.url,issue}))).slice(0,200),summary=home?.summary||'',purposeSignals=uniq([home?.title,home?.description,...(home?.headings?.h1||[])]).filter(Boolean).slice(0,6);return{summary,purposeSignals,features,pricing,ctas,faqs,products,articles,videos,pdfs,images,policies,contacts,technologies,seoIssues}}
async function enrichCaptionTracks(videos){const tracks=videos.flatMap(v=>(v.tracks||[]).map(t=>({...t,videoUrl:v.url}))).filter(t=>t.src).slice(0,3);for(const t of tracks){try{const{response}=await safeFetch(t.src,{accept:'text/vtt,text/plain,*/*;q=.5',timeout:10000});if(!response.ok)continue;const raw=await readTextLimited(response,250000);t.transcript=limitText(raw.replace(/^WEBVTT[^\n]*\n/i,'').replace(/\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->[^\n]+/g,'').replace(/<[^>]+>/g,' '),6000)}catch{}}return tracks}
async function analyzeWebsite(start,maxPages=10){
  await assertPublic(start);const origin=start.origin;let robots=null,robotsFound=false,sitemaps=[]
  try{const rr=await safeFetch(new URL('/robots.txt',origin),{accept:'text/plain,*/*;q=.5'});if(rr.response.ok){const txt=await readTextLimited(rr.response,500000);robots=robotsParser(new URL('/robots.txt',origin).toString(),txt);robotsFound=true;sitemaps=txt.split(/\r?\n/).map(x=>x.match(/^sitemap:\s*(.+)$/i)?.[1]?.trim()).filter(Boolean)}}catch{}
  const browser=await maybeLaunchBrowser(),renderBudget=browser?Math.min(3,maxPages):0,queue=[start.toString()],seen=new Set(),pages=[],skipped=[];let screenshot=null,renderedCount=0
  try{while(queue.length&&pages.length<maxPages){const candidate=queue.shift();if(seen.has(candidate))continue;seen.add(candidate);const u=new URL(candidate);if(u.origin!==origin)continue;if(robots&&!robots.isAllowed(candidate,USER_AGENT)){skipped.push({url:candidate,reason:'Disallowed by robots.txt'});continue}const priority=pages.length===0||/pricing|product|service|about|contact|features/i.test(u.pathname),renderedWanted=renderedCount<renderBudget&&priority;try{const loaded=await loadPage(candidate,origin,browser,renderedWanted,pages.length===0);if(loaded.page.rendered)renderedCount+=1;if(!screenshot&&loaded.screenshot)screenshot=loaded.screenshot;pages.push(loaded.page);for(const link of loaded.page.internalLinks){if(queue.length+pages.length>120)break;if(!seen.has(link))queue.push(link)}}catch(e){skipped.push({url:candidate,reason:e.name==='AbortError'?'Timed out':e.message})}}}finally{await closeBrowser(browser)}
  if(!pages.length)throw new Error('No public HTML pages could be analyzed.')
  const home=pages[0],navigation=uniqueObjects(pages.flatMap(p=>p.navigation),'url').slice(0,100),grouped=groupReport(pages),captions=await enrichCaptionTracks(grouped.videos),internalLinks=uniq(pages.flatMap(p=>p.internalLinks)),externalLinks=uniq(pages.flatMap(p=>p.externalLinks)),kindCounts=pages.reduce((m,p)=>{m[p.type]=(m[p.type]||0)+1;return m},{})
  return{kind:'website',analyzedAt:new Date().toISOString(),analysisId:crypto.randomUUID(),finalHomeUrl:home.url,site:{hostname:new URL(home.url).hostname,origin,title:home.title,description:home.description,summary:grouped.summary,language:home.language,canonical:home.canonical,detectedPrimaryType:home.type},totals:{pages:pages.length,internalLinks:internalLinks.length,externalLinks:externalLinks.length,images:grouped.images.length,videos:grouped.videos.length,pdfs:grouped.pdfs.length,words:pages.reduce((n,p)=>n+p.wordCount,0)},kindCounts,navigation,grouped,captions,screenshot,robots:{found:robotsFound,url:new URL('/robots.txt',origin).toString(),sitemaps},structure:pages.map(p=>({url:p.url,path:new URL(p.url).pathname,title:p.title,type:p.type,wordCount:p.wordCount,rendered:p.rendered})),pages,skipped,capabilities:{browserRendering:renderedCount>0,renderedPages:renderedCount,screenshot:Boolean(screenshot)}}
}
async function analyzePdf(url){const{response,url:finalUrl}=await safeFetch(url,{accept:'application/pdf,*/*;q=.3',timeout:20000});if(!response.ok)throw new Error(`HTTP ${response.status}`);const buf=await readBufferLimited(response,MAX_PDF_BYTES),parsed=await pdfParse(buf),text=cleanText(parsed.text||''),lines=(parsed.text||'').split(/\r?\n/).map(cleanText).filter(Boolean),headings=lines.filter(x=>x.length>=3&&x.length<100&&(x===x.toUpperCase()||/^\d+(?:\.\d+)*\s+/.test(x))).slice(0,80),urls=uniq((text.match(/https?:\/\/[^\s)\]}>,]+/g)||[]).map(x=>x.replace(/[.,;]+$/,''))).slice(0,100);return{kind:'pdf',analyzedAt:new Date().toISOString(),analysisId:crypto.randomUUID(),url:finalUrl.toString(),title:parsed.info?.Title||path.basename(finalUrl.pathname),author:parsed.info?.Author||'',subject:parsed.info?.Subject||'',pages:parsed.numpages||0,words:text?text.split(/\s+/).length:0,summary:limitText(text,1000),headings,links:urls,metadata:parsed.info||{},textPreview:limitText(text,10000)}}
async function analyzeDirectVideo(url,response,finalUrl){const ct=response.headers.get('content-type')||'video',length=Number(response.headers.get('content-length')||0);return{kind:'video',analyzedAt:new Date().toISOString(),analysisId:crypto.randomUUID(),url:finalUrl.toString(),contentType:ct,sizeBytes:length||null,provider:'direct-file',note:'Direct video detected. SiteScope can organize public metadata and caption tracks when they are exposed by a web page. Full scene-by-scene semantic video understanding requires an AI media-analysis provider.'}}
async function analyzeAny(input,maxPages=10){const start=normalizeInput(input);await assertPublic(start);let probe;try{probe=await safeFetch(start,{method:'HEAD',timeout:10000})}catch{probe=null}const ct=(probe?.response?.headers.get('content-type')||'').toLowerCase();if(ct.includes('application/pdf')||/\.pdf(?:$|\?)/i.test(start.toString()))return analyzePdf(start);if(ct.startsWith('video/')||/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(start.toString())){if(probe?.response)return analyzeDirectVideo(start,probe.response,probe.url);const p=await safeFetch(start,{method:'HEAD'});return analyzeDirectVideo(start,p.response,p.url)}return analyzeWebsite(start,Math.min(15,Math.max(1,Number(maxPages)||10)))}

app.get('/api/health',(req,res)=>res.json({ok:true,version:2}))
app.post('/api/analyze',async(req,res)=>{try{res.json(await analyzeAny(req.body.url,req.body.maxPages))}catch(e){console.error(e);res.status(400).json({error:e.message||'Could not analyze this URL.'})}})
app.get('/robots.txt',(req,res)=>{const base=process.env.PUBLIC_ORIGIN||`${req.protocol}://${req.get('host')}`;res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`)})
app.get('/sitemap.xml',(req,res)=>{const base=process.env.PUBLIC_ORIGIN||`${req.protocol}://${req.get('host')}`,paths=['/','/website-analyzer','/website-structure-analyzer','/website-link-analyzer','/pdf-link-analyzer','/product-page-analyzer','/article-analyzer','/compare-websites','/website-change-monitor','/how-it-works','/faq','/privacy','/terms'];res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p=>`<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`)})
app.use(express.static(dist,{extensions:['html']}))
app.get('*',async(req,res)=>{try{const route=req.path==='/'?'':req.path.replace(/^\//,''),file=route?path.join(dist,route,'index.html'):path.join(dist,'index.html');let html=await readFile(file,'utf8').catch(()=>readFile(path.join(dist,'index.html'),'utf8'));const base=process.env.PUBLIC_ORIGIN||`${req.protocol}://${req.get('host')}`;html=html.replaceAll('__SITE_ORIGIN__',base);res.type('html').send(html)}catch{res.status(404).send('Not found')}})
app.listen(PORT,()=>console.log(`SiteScope v2 running on ${PORT}`))
