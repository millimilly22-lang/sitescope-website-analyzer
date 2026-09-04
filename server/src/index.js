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
import OpenAI from 'openai'

const app = express()
const PORT = process.env.PORT || 8787
const USER_AGENT = 'SiteScopeBot/3.0 (+public link analysis)'
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(__dirname, '../../client/dist')
const MAX_HTML_BYTES = 4_000_000
const MAX_PDF_BYTES = 20_000_000
const MAX_PDF_TEXT = 300_000
const browserSlots = { active: 0, max: 1 }
const analysisContexts = new Map()
const CONTEXT_TTL = 30 * 60 * 1000

app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))

const buckets = new Map()
app.use('/api/', (req, res, next) => {
  if (req.path === '/health') return next()
  const key = req.ip || 'unknown'
  const now = Date.now()
  const b = buckets.get(key) || { start: now, count: 0 }
  if (now - b.start > 3_600_000) { b.start = now; b.count = 0 }
  b.count += 1
  buckets.set(key, b)
  if (b.count > 60) return res.status(429).json({ error: 'Too many requests. Please try again later.' })
  next()
})

function cleanText(s = '') { return String(s).replace(/\s+/g, ' ').trim() }
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))] }
function uniqueObjects(arr, key = 'url') {
  const seen = new Set()
  return (arr || []).filter(x => {
    const k = x?.[key] || JSON.stringify(x)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
}
function limitText(s = '', n = 1200) {
  const t = cleanText(s)
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t
}
function normalizeInput(v) {
  if (!v || typeof v !== 'string') throw new Error('Enter a public URL.')
  let s = v.trim()
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  const u = new URL(s)
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.')
  u.username = ''
  u.password = ''
  return u
}
function privateIp(address) {
  try { return ipaddr.parse(address).range() !== 'unicast' } catch { return true }
}
async function assertPublic(url) {
  const u = url instanceof URL ? url : new URL(url)
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local/private network addresses are not allowed.')
  }
  if (ipaddr.isValid(host) && privateIp(host)) throw new Error('Local/private network addresses are not allowed.')
  const records = await dns.lookup(host, { all: true })
  if (!records.length || records.some(r => privateIp(r.address))) {
    throw new Error('Local/private network addresses are not allowed.')
  }
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
        method: opts.method || 'GET',
        redirect: 'manual',
        signal: c.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: opts.accept || 'text/html,application/xhtml+xml,application/pdf,text/plain;q=.8,*/*;q=.2',
          ...(opts.headers || {})
        }
      })
    } finally {
      clearTimeout(timer)
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location')
      if (!loc) throw new Error('Invalid redirect.')
      u = new URL(loc, u)
      continue
    }
    return { response: r, url: u }
  }
  throw new Error('Too many redirects.')
}
async function readTextLimited(response, maxBytes = MAX_HTML_BYTES) {
  const len = Number(response.headers.get('content-length') || 0)
  if (len && len > maxBytes) throw new Error('Page is too large to analyze.')
  const ab = await response.arrayBuffer()
  if (ab.byteLength > maxBytes) throw new Error('Page is too large to analyze.')
  return new TextDecoder().decode(ab)
}
async function readBufferLimited(response, maxBytes) {
  const len = Number(response.headers.get('content-length') || 0)
  if (len && len > maxBytes) throw new Error('File is too large to analyze.')
  const ab = await response.arrayBuffer()
  if (ab.byteLength > maxBytes) throw new Error('File is too large to analyze.')
  return Buffer.from(ab)
}
function absolute(href, base) {
  try {
    const u = new URL(href, base)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    u.hash = ''
    return u.toString()
  } catch { return null }
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
  if (typeof value === 'object') {
    if (value['@type']) out.push(value)
    if (value['@graph']) flattenJsonLd(value['@graph'], out)
  }
  return out
}
function parseJsonLd($) {
  const nodes = []
  $('script[type="application/ld+json"]').each((_, el) => {
    try { flattenJsonLd(JSON.parse($(el).html() || 'null'), nodes) } catch {}
  })
  return nodes
}
function typeList(node) {
  return Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']].filter(Boolean)
}
function firstValue(v) {
  if (Array.isArray(v)) return firstValue(v[0])
  if (v && typeof v === 'object') return v.name || v.url || v['@id'] || ''
  return v == null ? '' : String(v)
}
function detectTechnologies(html, $) {
  const h = html.toLowerCase()
  const out = []
  const generator = cleanText($('meta[name="generator"]').attr('content') || '')
  if (generator) out.push(generator)
  const rules = [
    ['WordPress', /wp-content|wp-includes/],
    ['Shopify', /cdn\.shopify\.com|shopify-section/],
    ['Wix', /wixstatic\.com|wix-code/],
    ['Webflow', /webflow\.com|w-webflow/],
    ['Next.js', /__next|_next\//],
    ['Nuxt', /__nuxt|_nuxt\//],
    ['React', /reactroot|data-reactroot/],
    ['Squarespace', /squarespace/],
    ['WooCommerce', /woocommerce/],
    ['Google Analytics', /googletagmanager|google-analytics/],
    ['Stripe', /stripe\.com|js\.stripe/],
    ['Cloudflare', /cloudflare/]
  ]
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
    const raw = cleanText($(el).attr('href') || '')
    const text = cleanText($(el).text()) || raw
    if (/^mailto:/i.test(raw)) { emails.push(raw.replace(/^mailto:/i, '').split('?')[0]); return }
    if (/^tel:/i.test(raw)) { phones.push(raw.replace(/^tel:/i, '').split('?')[0]); return }
    const href = absolute(raw, url)
    if (!href) return
    rawLinks.push({ text, url: href })
    const u = new URL(href)
    if (u.origin === origin) internal.push(href); else external.push(href)
    if (/\.pdf(?:$|\?)/i.test(href)) pdfLinks.push(href)
    if (/facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|x\.com|twitter\.com/i.test(href)) socials.push(href)
    if ($(el).parents('nav,header').length && u.origin === origin) nav.push({ text, url: href })
  })

  const title = cleanText($('title').first().text())
  const description = cleanText($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '')
  const headings = {
    h1: $('h1').map((_, x) => cleanText($(x).text())).get().filter(Boolean).slice(0, 20),
    h2: $('h2').map((_, x) => cleanText($(x).text())).get().filter(Boolean).slice(0, 80),
    h3: $('h3').map((_, x) => cleanText($(x).text())).get().filter(Boolean).slice(0, 120)
  }
  const canonical = absolute($('link[rel="canonical"]').attr('href') || '', url)
  const bodyText = cleanText($('body').text())
  const summary = limitText(description || headings.h1[0] || title || bodyText, 600)
  const contentExcerpt = limitText(bodyText, 5000)
  const og = {
    title: cleanText($('meta[property="og:title"]').attr('content') || ''),
    description: cleanText($('meta[property="og:description"]').attr('content') || ''),
    image: absolute($('meta[property="og:image"]').attr('content') || '', url),
    type: cleanText($('meta[property="og:type"]').attr('content') || ''),
    video: absolute($('meta[property="og:video"]').attr('content') || '', url)
  }

  const images = []
  $('img').each((_, el) => {
    const node = $(el)
    const src = absolute(node.attr('src') || node.attr('data-src') || node.attr('data-lazy-src') || '', url)
    if (!src) return
    images.push({
      src,
      alt: cleanText(node.attr('alt') || ''),
      width: Number(node.attr('width') || 0),
      height: Number(node.attr('height') || 0),
      className: cleanText(node.attr('class') || ''),
      sourcePage: url
    })
  })
  if (og.image) images.push({ src: og.image, alt: og.title || title, width: 0, height: 0, className: 'og:image', sourcePage: url })
  const finalImages = uniqueObjects([...(rendered.images || []).map(i => ({ ...i, sourcePage: url })), ...images], 'src')
    .map(i => ({ ...i, kind: imageKind(i, title) }))
    .slice(0, 250)

  const ctas = []
  $('button,a').each((_, el) => {
    const text = cleanText($(el).text())
    if (!text || text.length > 90) return
    const cls = cleanText($(el).attr('class') || '').toLowerCase()
    const href = $(el).is('a') ? absolute($(el).attr('href') || '', url) : null
    if (/buy|shop|start|get|try|sign|join|book|contact|download|subscribe|learn|demo|order|add to cart|checkout|apply|request/i.test(text) || /btn|button|cta/.test(cls)) {
      ctas.push({ text, url: href, sourcePage: url })
    }
  })

  const forms = []
  $('form').each((_, el) => {
    const f = $(el)
    forms.push({
      action: absolute(f.attr('action') || url, url) || url,
      method: (f.attr('method') || 'get').toUpperCase(),
      fields: f.find('input,select,textarea').map((_, x) => cleanText($(x).attr('name') || $(x).attr('placeholder') || $(x).attr('type') || '')).get().filter(Boolean).slice(0, 20)
    })
  })

  const faqs = []
  $('details').each((_, el) => {
    const q = cleanText($(el).find('summary').first().text())
    const a = limitText($(el).text().replace(q, ''), 600)
    if (q) faqs.push({ question: q, answer: a })
  })
  $('h2,h3,h4').each((_, el) => {
    const q = cleanText($(el).text())
    if (!q.endsWith('?')) return
    faqs.push({ question: q, answer: limitText($(el).next('p,div').text(), 600) })
  })

  const visibleEmails = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  const priceMatches = bodyText.match(/(?:[$€£¥]|USD|EUR|GBP|PLN|zł)\s?\d[\d.,]*(?:\s?(?:\/|per)\s?(?:month|mo|year|yr))?|\d[\d.,]*\s?(?:USD|EUR|GBP|PLN|zł)/gi) || []
  const prices = uniq(priceMatches.map(cleanText)).slice(0, 50)

  const videos = []
  $('video').each((_, el) => {
    const v = $(el)
    const sources = []
    const src = absolute(v.attr('src') || '', url)
    if (src) sources.push(src)
    v.find('source[src]').each((__, s) => {
      const x = absolute($(s).attr('src') || '', url)
      if (x) sources.push(x)
    })
    const tracks = v.find('track[src]').map((__, t) => ({
      kind: $(t).attr('kind') || '',
      label: $(t).attr('label') || '',
      src: absolute($(t).attr('src') || '', url)
    })).get().filter(x => x.src)
    videos.push({ provider: 'html5', url: sources[0] || url, sources: uniq(sources), poster: absolute(v.attr('poster') || '', url), tracks, sourcePage: url })
  })
  $('iframe[src]').each((_, el) => {
    const src = absolute($(el).attr('src') || '', url)
    if (!src) return
    let provider = ''
    if (/youtube\.com|youtu\.be/.test(src)) provider = 'youtube'
    else if (/vimeo\.com/.test(src)) provider = 'vimeo'
    else if (/wistia|loom\.com|dailymotion/.test(src)) provider = 'embedded'
    if (provider) videos.push({ provider, url: src, sources: [src], poster: null, tracks: [], sourcePage: url })
  })
  if (og.video) videos.push({ provider: 'open-graph', url: og.video, sources: [og.video], poster: og.image, tracks: [], sourcePage: url })

  const products = [], articles = []
  for (const node of jsonLdNodes) {
    const types = typeList(node).map(String)
    if (types.some(t => /Product/i.test(t))) {
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {}
      products.push({
        name: firstValue(node.name),
        brand: firstValue(node.brand),
        sku: firstValue(node.sku),
        price: firstValue(offer.price || offer.lowPrice),
        currency: firstValue(offer.priceCurrency),
        availability: firstValue(offer.availability),
        image: firstValue(node.image),
        url: firstValue(node.url) || url,
        sourcePage: url
      })
    }
    if (types.some(t => /Article|BlogPosting|NewsArticle/i.test(t))) {
      articles.push({
        headline: firstValue(node.headline || node.name),
        author: firstValue(node.author),
        datePublished: firstValue(node.datePublished),
        dateModified: firstValue(node.dateModified),
        image: firstValue(node.image),
        url: firstValue(node.url || node.mainEntityOfPage) || url,
        sourcePage: url
      })
    }
  }

  let detectedType = pageType(new URL(url).pathname)
  const allTypes = uniq(jsonLdNodes.flatMap(typeList).map(String))
  if (products.length || allTypes.some(t => /Product/i.test(t)) || /add to cart|buy now/i.test(bodyText)) detectedType = 'product'
  else if (articles.length || allTypes.some(t => /Article|BlogPosting|NewsArticle/i.test(t)) || og.type === 'article') detectedType = 'article'
  else if (videos.length && /video/.test(og.type)) detectedType = 'video'

  const seoIssues = []
  if (!title) seoIssues.push('Missing page title')
  if (!description) seoIssues.push('Missing meta description')
  if (!headings.h1.length) seoIssues.push('Missing H1 heading')
  if (headings.h1.length > 1) seoIssues.push('Multiple H1 headings')
  if (!canonical) seoIssues.push('Canonical URL not declared')
  const missingAlt = finalImages.filter(i => !i.alt && i.kind !== 'icon/avatar').length
  if (missingAlt) seoIssues.push(`${missingAlt} important images missing alt text`)

  return {
    url, title, description, summary, contentExcerpt,
    language: $('html').attr('lang') || '', canonical, type: detectedType,
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0,
    headings,
    ctas: uniqueObjects(ctas, 'text').slice(0, 50),
    prices,
    forms,
    faqs: uniqueObjects(faqs, 'question').slice(0, 40),
    internalLinks: uniq(internal),
    externalLinks: uniq(external),
    links: rawLinks.slice(0, 300),
    pdfLinks: uniq(pdfLinks),
    contacts: { emails: uniq([...emails, ...visibleEmails]), phones: uniq(phones), socials: uniq(socials) },
    navigation: uniqueObjects(nav, 'url').slice(0, 100),
    images: finalImages,
    videos: uniqueObjects(videos, 'url'),
    products,
    articles,
    structuredDataTypes: allTypes,
    technologies: detectTechnologies(html, $),
    openGraph: og,
    seoIssues,
    rendered: Boolean(rendered.rendered),
    sections: rendered.sections || [],
    viewport: rendered.viewport || null
  }
}

async function maybeLaunchBrowser() {
  if (browserSlots.active >= browserSlots.max) return null
  browserSlots.active += 1
  try {
    const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
      import('puppeteer-core'),
      import('@sparticuz/chromium')
    ])
    const executablePath = await chromium.executablePath()
    return await puppeteer.launch({
      executablePath,
      args: chromium.args,
      headless: true,
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 }
    })
  } catch (e) {
    browserSlots.active = Math.max(0, browserSlots.active - 1)
    console.warn('Browser rendering unavailable:', e.message)
    return null
  }
}
async function closeBrowser(browser) {
  if (!browser) return
  try { await browser.close() } catch {}
  browserSlots.active = Math.max(0, browserSlots.active - 1)
}
async function renderPage(browser, url, withScreenshot = false) {
  if (!browser) return null
  await assertPublic(url)
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', async req => {
    try {
      const ru = new URL(req.url())
      if (!['http:', 'https:', 'data:', 'blob:'].includes(ru.protocol)) return req.abort()
      if (['data:', 'blob:'].includes(ru.protocol)) return req.continue()
      if (req.resourceType() === 'media') return req.abort()
      await assertPublic(ru)
      return req.continue()
    } catch { return req.abort() }
  })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 18_000 })
    await new Promise(r => setTimeout(r, 800))
    const rendered = await page.evaluate(() => {
      const text = el => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
      const images = [...document.images].map(img => ({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        className: String(img.className || '')
      })).filter(x => /^https?:/i.test(x.src))
      const sections = [...document.querySelectorAll('main section, main article, section, article')].map((el, i) => {
        const r = el.getBoundingClientRect()
        const heading = el.querySelector('h1,h2,h3')
        return {
          index: i + 1,
          tag: el.tagName.toLowerCase(),
          heading: text(heading),
          text: text(el).slice(0, 700),
          y: Math.round(r.top + window.scrollY),
          height: Math.round(r.height)
        }
      }).filter(x => x.text.length > 40 && x.height > 20).slice(0, 40)
      return { rendered: true, images, sections, viewport: { width: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight } }
    })
    const html = await page.content()
    let screenshot = null
    if (withScreenshot) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false })
      screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`
    }
    return { html, rendered, screenshot, finalUrl: page.url() }
  } finally {
    await page.close().catch(() => {})
  }
}
async function fetchHtmlPage(url) {
  const { response, url: finalUrl } = await safeFetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const ct = (response.headers.get('content-type') || '').toLowerCase()
  if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) throw new Error('Not an HTML page')
  return { html: await readTextLimited(response), finalUrl: finalUrl.toString() }
}
async function loadPage(url, origin, browser, renderedWanted = false, withScreenshot = false) {
  if (renderedWanted && browser) {
    try {
      const r = await renderPage(browser, url, withScreenshot)
      if (r) return { page: extractPage(r.html, r.finalUrl, origin, r.rendered), screenshot: r.screenshot }
    } catch (e) {
      console.warn('Rendered page failed; falling back:', e.message)
    }
  }
  const r = await fetchHtmlPage(url)
  return { page: extractPage(r.html, r.finalUrl, origin, {}), screenshot: null }
}
function groupReport(pages) {
  const home = pages[0]
  const pricing = uniq(pages.flatMap(p => p.prices)).slice(0, 50)
  const ctas = uniqueObjects(pages.flatMap(p => p.ctas), 'text').slice(0, 60)
  const faqs = uniqueObjects(pages.flatMap(p => p.faqs), 'question').slice(0, 50)
  const products = uniqueObjects(pages.flatMap(p => p.products), 'name').slice(0, 80)
  const articles = uniqueObjects(pages.flatMap(p => p.articles), 'url').slice(0, 80)
  const videos = uniqueObjects(pages.flatMap(p => p.videos), 'url').slice(0, 80)
  const pdfs = uniq(pages.flatMap(p => p.pdfLinks)).slice(0, 120)
  const images = uniqueObjects(pages.flatMap(p => p.images), 'src').slice(0, 500)
  const policies = uniqueObjects(
    pages.flatMap(p => p.links).filter(l => /privacy|terms|refund|shipping|cookie|policy|cancel/i.test(`${l.text} ${l.url}`)),
    'url'
  ).slice(0, 60)
  const contacts = {
    emails: uniq(pages.flatMap(p => p.contacts.emails)),
    phones: uniq(pages.flatMap(p => p.contacts.phones)),
    socials: uniq(pages.flatMap(p => p.contacts.socials))
  }
  const technologies = uniq(pages.flatMap(p => p.technologies))
  const seoIssues = pages.flatMap(p => p.seoIssues.map(issue => ({ page: p.url, issue }))).slice(0, 250)
  return {
    summary: home?.summary || '',
    purposeSignals: uniq([home?.title, home?.description, ...(home?.headings?.h1 || [])]).filter(Boolean).slice(0, 8),
    pricing, ctas, faqs, products, articles, videos, pdfs, images, policies, contacts, technologies, seoIssues
  }
}
async function enrichCaptionTracks(videos) {
  const tracks = videos.flatMap(v => (v.tracks || []).map(t => ({ ...t, videoUrl: v.url }))).filter(t => t.src).slice(0, 3)
  for (const t of tracks) {
    try {
      const { response } = await safeFetch(t.src, { accept: 'text/vtt,text/plain,*/*;q=.5', timeout: 10_000 })
      if (!response.ok) continue
      const raw = await readTextLimited(response, 250_000)
      t.transcript = limitText(
        raw.replace(/^WEBVTT[^\n]*\n/i, '')
          .replace(/\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->[^\n]+/g, '')
          .replace(/<[^>]+>/g, ' '),
        12_000
      )
    } catch {}
  }
  return tracks
}
async function analyzeWebsite(start, maxPages = 10) {
  await assertPublic(start)
  const origin = start.origin
  let robots = null, robotsFound = false, sitemaps = []
  try {
    const rr = await safeFetch(new URL('/robots.txt', origin), { accept: 'text/plain,*/*;q=.5' })
    if (rr.response.ok) {
      const txt = await readTextLimited(rr.response, 500_000)
      robots = robotsParser(new URL('/robots.txt', origin).toString(), txt)
      robotsFound = true
      sitemaps = txt.split(/\r?\n/).map(x => x.match(/^sitemap:\s*(.+)$/i)?.[1]?.trim()).filter(Boolean)
    }
  } catch {}

  const browser = await maybeLaunchBrowser()
  const renderBudget = browser ? Math.min(3, maxPages) : 0
  const queue = [start.toString()]
  const seen = new Set()
  const pages = [], skipped = []
  let screenshot = null, renderedCount = 0

  try {
    while (queue.length && pages.length < maxPages) {
      const candidate = queue.shift()
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const u = new URL(candidate)
      if (u.origin !== origin) continue
      if (robots && !robots.isAllowed(candidate, USER_AGENT)) {
        skipped.push({ url: candidate, reason: 'Disallowed by robots.txt' })
        continue
      }
      const priority = pages.length === 0 || /pricing|product|service|about|contact|features|plans/i.test(u.pathname)
      const renderedWanted = renderedCount < renderBudget && priority
      try {
        const loaded = await loadPage(candidate, origin, browser, renderedWanted, pages.length === 0)
        if (loaded.page.rendered) renderedCount += 1
        if (!screenshot && loaded.screenshot) screenshot = loaded.screenshot
        pages.push(loaded.page)
        for (const link of loaded.page.internalLinks) {
          if (queue.length + pages.length > 140) break
          if (!seen.has(link)) queue.push(link)
        }
      } catch (e) {
        skipped.push({ url: candidate, reason: e.name === 'AbortError' ? 'Timed out' : e.message })
      }
    }
  } finally {
    await closeBrowser(browser)
  }

  if (!pages.length) throw new Error('No public HTML pages could be analyzed.')
  const home = pages[0]
  const grouped = groupReport(pages)
  const captions = await enrichCaptionTracks(grouped.videos)
  const internalLinks = uniq(pages.flatMap(p => p.internalLinks))
  const externalLinks = uniq(pages.flatMap(p => p.externalLinks))
  const navigation = uniqueObjects(pages.flatMap(p => p.navigation), 'url').slice(0, 120)

  return {
    kind: 'website',
    analyzedAt: new Date().toISOString(),
    analysisId: crypto.randomUUID(),
    finalHomeUrl: home.url,
    site: {
      hostname: new URL(home.url).hostname,
      origin,
      title: home.title,
      description: home.description,
      summary: grouped.summary,
      language: home.language,
      canonical: home.canonical,
      detectedPrimaryType: home.type
    },
    totals: {
      pages: pages.length,
      internalLinks: internalLinks.length,
      externalLinks: externalLinks.length,
      images: grouped.images.length,
      videos: grouped.videos.length,
      pdfs: grouped.pdfs.length,
      words: pages.reduce((n, p) => n + p.wordCount, 0)
    },
    navigation,
    grouped,
    captions,
    screenshot,
    robots: { found: robotsFound, url: new URL('/robots.txt', origin).toString(), sitemaps },
    structure: pages.map(p => ({ url: p.url, path: new URL(p.url).pathname, title: p.title, type: p.type, wordCount: p.wordCount, rendered: p.rendered })),
    pages,
    skipped,
    capabilities: {
      browserRendering: renderedCount > 0,
      renderedPages: renderedCount,
      screenshot: Boolean(screenshot)
    }
  }
}

function detectDocumentType(text = '') {
  const t = text.toLowerCase()
  if (/\binvoice\b|invoice number|amount due|vat|subtotal/.test(t)) return 'invoice'
  if (/\bcurriculum vitae\b|\bresume\b|work experience|education|skills/.test(t)) return 'CV / resume'
  if (/\bagreement\b|\bcontract\b|terms and conditions|hereinafter|party to this/.test(t)) return 'contract / agreement'
  if (/abstract|methodology|references|doi:|research/.test(t)) return 'research paper'
  if (/annual report|executive summary|financial year|quarterly report/.test(t)) return 'report'
  if (/instructions|installation|troubleshooting|user guide|manual/.test(t)) return 'manual / guide'
  if (/application form|please complete|applicant/.test(t)) return 'application / form'
  if (/brochure|our services|contact us|about us/.test(t)) return 'brochure'
  return 'document'
}
function extractDocumentSignals(rawText = '') {
  const clean = cleanText(rawText)
  const emails = uniq(clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).slice(0, 40)
  const phones = uniq(clean.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || []).map(cleanText).slice(0, 40)
  const amounts = uniq(clean.match(/(?:[$€£¥]|USD|EUR|GBP|PLN|zł)\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP|PLN|zł)/gi) || []).map(cleanText).slice(0, 80)
  const dates = uniq(clean.match(/\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/gi) || []).slice(0, 80)
  return { emails, phones, amounts, dates }
}
async function analyzePdf(url) {
  const { response, url: finalUrl } = await safeFetch(url, { accept: 'application/pdf,*/*;q=.3', timeout: 20_000 })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const buf = await readBufferLimited(response, MAX_PDF_BYTES)
  const parsed = await pdfParse(buf)
  const rawText = parsed.text || ''
  const text = cleanText(rawText)
  const lines = rawText.split(/\r?\n/).map(cleanText).filter(Boolean)
  const headings = lines.filter(x => x.length >= 3 && x.length < 120 && (x === x.toUpperCase() || /^\d+(?:\.\d+)*\s+/.test(x))).slice(0, 120)
  const urls = uniq((text.match(/https?:\/\/[^\s)\]}>,]+/g) || []).map(x => x.replace(/[.,;]+$/, ''))).slice(0, 150)
  const signals = extractDocumentSignals(rawText)
  const fullText = rawText.slice(0, MAX_PDF_TEXT)
  return {
    kind: 'pdf',
    analyzedAt: new Date().toISOString(),
    analysisId: crypto.randomUUID(),
    url: finalUrl.toString(),
    title: parsed.info?.Title || path.basename(finalUrl.pathname),
    author: parsed.info?.Author || '',
    subject: parsed.info?.Subject || '',
    documentType: detectDocumentType(text),
    pages: parsed.numpages || 0,
    words: text ? text.split(/\s+/).length : 0,
    summary: limitText(text, 1200),
    headings,
    links: urls,
    metadata: parsed.info || {},
    signals,
    fullText,
    textTruncated: rawText.length > MAX_PDF_TEXT,
    originalCharacters: rawText.length
  }
}
async function analyzeDirectVideo(url, response, finalUrl) {
  const ct = response.headers.get('content-type') || 'video'
  const length = Number(response.headers.get('content-length') || 0)
  return {
    kind: 'video',
    analyzedAt: new Date().toISOString(),
    analysisId: crypto.randomUUID(),
    url: finalUrl.toString(),
    contentType: ct,
    sizeBytes: length || null,
    provider: 'direct-file',
    note: 'Direct video detected. Full scene-by-scene understanding is not enabled yet unless a page exposes transcript/caption text.'
  }
}
async function analyzeAny(input, maxPages = 10) {
  const start = normalizeInput(input)
  await assertPublic(start)
  let probe
  try { probe = await safeFetch(start, { method: 'HEAD', timeout: 10_000 }) } catch { probe = null }
  const ct = (probe?.response?.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('application/pdf') || /\.pdf(?:$|\?)/i.test(start.toString())) return analyzePdf(start)
  if (ct.startsWith('video/') || /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(start.toString())) {
    if (probe?.response) return analyzeDirectVideo(start, probe.response, probe.url)
    const p = await safeFetch(start, { method: 'HEAD' })
    return analyzeDirectVideo(start, p.response, p.url)
  }
  return analyzeWebsite(start, Math.min(15, Math.max(1, Number(maxPages) || 10)))
}

function buildAIContext(report) {
  if (report.kind === 'pdf') {
    return {
      kind: 'pdf',
      url: report.url,
      title: report.title,
      author: report.author,
      subject: report.subject,
      documentTypeGuess: report.documentType,
      pages: report.pages,
      headings: report.headings.slice(0, 80),
      signals: report.signals,
      links: report.links.slice(0, 30),
      text: report.fullText.slice(0, 45_000)
    }
  }
  if (report.kind === 'video') {
    return { kind: 'video', url: report.url, contentType: report.contentType, sizeBytes: report.sizeBytes, note: report.note }
  }
  return {
    kind: 'website',
    url: report.finalHomeUrl,
    site: report.site,
    navigation: report.navigation.slice(0, 30),
    pricing: report.grouped.pricing.slice(0, 30),
    products: report.grouped.products.slice(0, 20),
    articles: report.grouped.articles.slice(0, 15),
    faqs: report.grouped.faqs.slice(0, 20),
    contacts: report.grouped.contacts,
    policies: report.grouped.policies.slice(0, 20),
    captions: report.captions.filter(x => x.transcript).map(x => ({ label: x.label, transcript: x.transcript.slice(0, 8000) })).slice(0, 2),
    pages: report.pages.slice(0, 10).map(p => ({
      url: p.url,
      type: p.type,
      title: p.title,
      description: p.description,
      headings: { h1: p.headings.h1.slice(0, 5), h2: p.headings.h2.slice(0, 12) },
      prices: p.prices.slice(0, 15),
      ctas: p.ctas.slice(0, 12),
      content: p.contentExcerpt.slice(0, 3500)
    }))
  }
}
function rememberContext(report) {
  analysisContexts.set(report.analysisId, { context: buildAIContext(report), expiresAt: Date.now() + CONTEXT_TTL })
  for (const [id, item] of analysisContexts) if (item.expiresAt < Date.now()) analysisContexts.delete(id)
}
function getContext(id) {
  const item = analysisContexts.get(id)
  if (!item || item.expiresAt < Date.now()) {
    analysisContexts.delete(id)
    return null
  }
  return item.context
}
function aiClient() {
  if (!process.env.OPENAI_API_KEY) return null
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}
function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(raw) } catch {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1))
  throw new Error('AI returned an unreadable result.')
}
async function importantAnalysis(context) {
  const client = aiClient()
  if (!client) throw new Error('AI_NOT_CONFIGURED')
  const prompt = `You are the intelligence layer for SiteScope. Read the extracted public-link data below and tell the user what actually matters, not technical crawler trivia.\n\nReturn ONLY valid JSON with this exact top-level shape:\n{\n  "linkType": "short type label",\n  "plainSummary": "2-5 sentence plain-language explanation",\n  "audience": "who this is mainly for",\n  "importantFacts": [{"label":"", "value":"", "whyItMatters":""}],\n  "howItWorks": [""],\n  "offers": [{"name":"", "price":"", "details":""}],\n  "importantNumbers": [{"value":"", "meaning":""}],\n  "importantDates": [{"date":"", "meaning":""}],\n  "requirements": [""],\n  "conditionsWarnings": [""],\n  "nextActions": [""],\n  "questionsYouCanAsk": [""]\n}\n\nRules:\n- Use only information supported by the supplied extraction.\n- Do not invent missing prices, dates, requirements, or policies.\n- Rank facts by practical importance.\n- For PDFs, prioritize obligations, totals, parties, dates, deadlines, requirements, and important sections according to document type.\n- For product pages, prioritize what it is, price, variants/specs, availability, shipping/returns if present.\n- For business websites, prioritize what the business does, services, pricing, process, contacts, eligibility, policies.\n- For articles, prioritize main claim, evidence, dates, conclusions, sources.\n- Keep arrays concise; omit unsupported items by returning [].\n\nEXTRACTED DATA:\n${JSON.stringify(context)}`
  const response = await client.responses.create({
    model: AI_MODEL,
    input: prompt,
    reasoning: { effort: 'low' },
    max_output_tokens: 4000
  })
  return extractJson(response.output_text)
}
async function answerQuestion(context, question) {
  const client = aiClient()
  if (!client) throw new Error('AI_NOT_CONFIGURED')
  const prompt = `Answer the user's question using ONLY the extracted public-link information below.\nIf the information is not present, say clearly that it was not found in the analyzed content.\nBe concise but useful. Mention relevant numbers, dates, conditions, and source page URLs when available.\n\nQUESTION:\n${question}\n\nEXTRACTED DATA:\n${JSON.stringify(context)}`
  const response = await client.responses.create({
    model: AI_MODEL,
    input: prompt,
    reasoning: { effort: 'low' },
    max_output_tokens: 1800
  })
  return response.output_text?.trim() || 'No answer returned.'
}

app.get('/api/health', (req, res) => res.json({
  ok: true,
  version: 3,
  ai: { available: Boolean(process.env.OPENAI_API_KEY), model: AI_MODEL }
}))

app.post('/api/analyze', async (req, res) => {
  try {
    const report = await analyzeAny(req.body.url, req.body.maxPages)
    rememberContext(report)
    report.ai = { available: Boolean(process.env.OPENAI_API_KEY), model: AI_MODEL }
    res.json(report)
  } catch (e) {
    console.error(e)
    res.status(400).json({ error: e.message || 'Could not analyze this URL.' })
  }
})

app.post('/api/important', async (req, res) => {
  try {
    const context = getContext(req.body.analysisId)
    if (!context) return res.status(410).json({ error: 'This analysis expired. Analyze the link again.' })
    const important = await importantAnalysis(context)
    res.json({ important })
  } catch (e) {
    if (e.message === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: 'AI understanding is not configured on this server.' })
    console.error(e)
    res.status(500).json({ error: 'Could not create the important analysis.' })
  }
})

app.post('/api/ask', async (req, res) => {
  try {
    const question = cleanText(req.body.question || '')
    if (!question) return res.status(400).json({ error: 'Enter a question.' })
    if (question.length > 1000) return res.status(400).json({ error: 'Question is too long.' })
    const context = getContext(req.body.analysisId)
    if (!context) return res.status(410).json({ error: 'This analysis expired. Analyze the link again.' })
    const answer = await answerQuestion(context, question)
    res.json({ answer })
  } catch (e) {
    if (e.message === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: 'AI understanding is not configured on this server.' })
    console.error(e)
    res.status(500).json({ error: 'Could not answer this question.' })
  }
})

app.get('/robots.txt', (req, res) => {
  const base = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`)
})
app.get('/sitemap.xml', (req, res) => {
  const base = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`
  const paths = [
    '/', '/website-analyzer', '/website-structure-analyzer', '/website-link-analyzer',
    '/pdf-link-analyzer', '/product-page-analyzer', '/article-analyzer',
    '/compare-websites', '/website-change-monitor', '/how-it-works', '/faq', '/privacy', '/terms'
  ]
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`
  )
})

app.use(express.static(dist, { extensions: ['html'] }))
app.get('*', async (req, res) => {
  try {
    const route = req.path === '/' ? '' : req.path.replace(/^\//, '')
    const file = route ? path.join(dist, route, 'index.html') : path.join(dist, 'index.html')
    let html = await readFile(file, 'utf8').catch(() => readFile(path.join(dist, 'index.html'), 'utf8'))
    const base = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`
    html = html.replaceAll('__SITE_ORIGIN__', base)
    res.type('html').send(html)
  } catch {
    res.status(404).send('Not found')
  }
})

app.listen(PORT, () => console.log(`SiteScope v3 running on ${PORT}`))
