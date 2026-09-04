import express from 'express'
import * as cheerio from 'cheerio'
import ipaddr from 'ipaddr.js'
import robotsParser from 'robots-parser'
import dns from 'node:dns/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const app = express()
const PORT = process.env.PORT || 8787
const USER_AGENT = 'SiteScopeBot/1.1'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(__dirname, '../../client/dist')
app.use(express.json({ limit: '100kb' }))

const buckets = new Map()
app.use('/api/analyze', (req, res, next) => {
  const key = req.ip
  const now = Date.now()
  const bucket = buckets.get(key) || { start: now, count: 0 }
  if (now - bucket.start > 3600000) { bucket.start = now; bucket.count = 0 }
  bucket.count++
  buckets.set(key, bucket)
  if (bucket.count > 30) return res.status(429).json({ error: 'Too many analyses. Please try again later.' })
  next()
})

function normalizeInput(value) {
  if (!value || typeof value !== 'string') throw new Error('Enter a website URL.')
  let input = value.trim()
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.')
  return url
}
function privateIp(address) {
  try { return ipaddr.parse(address).range() !== 'unicast' } catch { return true }
}
async function assertPublic(url) {
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Local/private network addresses are not allowed.')
  const records = await dns.lookup(host, { all: true })
  if (!records.length || records.some(r => privateIp(r.address))) throw new Error('Local/private network addresses are not allowed.')
}
async function safeFetch(input, opts = {}) {
  let url = new URL(input)
  for (let i = 0; i < 5; i++) {
    await assertPublic(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let response
    try {
      response = await fetch(url, {
        ...opts,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=.8,*/*;q=.2',
          ...(opts.headers || {})
        }
      })
    } finally { clearTimeout(timer) }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('Invalid redirect.')
      url = new URL(location, url)
      continue
    }
    return { response, url }
  }
  throw new Error('Too many redirects.')
}
function cleanText(value = '') { return String(value).replace(/\s+/g, ' ').trim() }
function unique(values) { return [...new Set(values.filter(Boolean))] }
function cut(value = '', length = 650) { const s = cleanText(value); return s.length > length ? `${s.slice(0, length - 1).trim()}…` : s }
function pageType(pathname) {
  const p = pathname.toLowerCase()
  if (p === '/' || p === '') return 'home'
  if (p.includes('contact')) return 'contact'
  if (p.includes('about')) return 'about'
  if (p.includes('pricing') || p.includes('plans')) return 'pricing'
  if (p.includes('blog') || p.includes('news')) return 'blog'
  if (p.includes('product') || p.includes('shop') || p.includes('store')) return 'product'
  if (p.includes('service')) return 'service'
  if (p.includes('career') || p.includes('jobs')) return 'careers'
  if (p.includes('login') || p.includes('signin')) return 'login'
  return 'page'
}
function absolute(href, base) {
  try {
    const u = new URL(href, base)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    u.hash = ''
    return u.toString()
  } catch { return null }
}
function jsonLdTypes($) {
  const out = []
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || 'null')
      const walk = value => {
        if (!value) return
        if (Array.isArray(value)) return value.forEach(walk)
        if (typeof value === 'object') {
          if (value['@type']) Array.isArray(value['@type']) ? out.push(...value['@type']) : out.push(value['@type'])
          Object.values(value).forEach(walk)
        }
      }
      walk(json)
    } catch {}
  })
  return unique(out)
}
function imageSource($, el, base) {
  const node = $(el)
  const direct = node.attr('src') || node.attr('data-src') || node.attr('data-lazy-src') || node.attr('data-original')
  if (direct) return absolute(direct, base)
  const srcset = node.attr('srcset') || node.attr('data-srcset')
  if (!srcset) return null
  const candidates = srcset.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean)
  return candidates.length ? absolute(candidates[candidates.length - 1], base) : null
}
function extract(html, url, origin) {
  const $ = cheerio.load(html)
  const structuredDataTypes = jsonLdTypes($)
  const internal = [], external = [], navigation = [], emails = [], phones = [], socials = [], imageDetails = [], ctas = []

  $('a[href]').each((_, el) => {
    const raw = ($(el).attr('href') || '').trim()
    const label = cleanText($(el).text()) || cleanText($(el).attr('aria-label') || '')
    if (/^mailto:/i.test(raw)) { emails.push(raw.replace(/^mailto:/i, '').split('?')[0]); return }
    if (/^tel:/i.test(raw)) { phones.push(raw.replace(/^tel:/i, '').split('?')[0]); return }
    const href = absolute(raw, url)
    if (!href) return
    const parsed = new URL(href)
    if (parsed.origin === origin) internal.push(href); else external.push(href)
    if (/facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|x\.com|twitter\.com/i.test(href)) socials.push(href)
    if ($(el).parents('nav,header').length && parsed.origin === origin) navigation.push({ text: label || href, url: href })
    if (label && /(get started|start|try|buy|shop|book|contact|sign up|signup|subscribe|download|learn more|request|demo|join|apply|order|view pricing|pricing)/i.test(label)) ctas.push({ text: label, url: href })
  })

  $('button, input[type="submit"], input[type="button"]').each((_, el) => {
    const text = cleanText($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || '')
    if (text) ctas.push({ text, url: null })
  })

  $('img').each((_, el) => {
    const src = imageSource($, el, url)
    if (!src) return
    imageDetails.push({
      url: src,
      alt: cleanText($(el).attr('alt') || ''),
      title: cleanText($(el).attr('title') || ''),
      width: cleanText($(el).attr('width') || ''),
      height: cleanText($(el).attr('height') || ''),
      pageUrl: url
    })
  })

  const forms = $('form').map((_, el) => {
    const form = $(el)
    return {
      action: absolute(form.attr('action') || url, url) || url,
      method: (form.attr('method') || 'GET').toUpperCase(),
      fields: form.find('input,select,textarea').map((__, input) => ({
        type: $(input).attr('type') || input.tagName || 'field',
        name: $(input).attr('name') || '',
        placeholder: cleanText($(input).attr('placeholder') || '')
      })).get().slice(0, 20)
    }
  }).get().slice(0, 10)

  $('script:not([type="application/ld+json"]),style,noscript,template,svg').remove()
  const headings = {
    h1: $('h1').map((_, x) => cleanText($(x).text())).get().filter(Boolean),
    h2: $('h2').map((_, x) => cleanText($(x).text())).get().filter(Boolean),
    h3: $('h3').map((_, x) => cleanText($(x).text())).get().filter(Boolean)
  }
  const paragraphs = unique($('main p, article p, section p, body p').map((_, x) => cleanText($(x).text())).get().filter(x => x.length >= 35)).slice(0, 10)
  const bodyText = cleanText($('body').text())
  const visibleEmails = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  const priceMatches = bodyText.match(/(?:[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:PLN|USD|EUR|GBP|zł|€|£|\$)|(?:PLN|USD|EUR|GBP)\s?\d[\d.,]*)/gi) || []
  const description = cleanText($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '')
  const title = cleanText($('title').first().text() || $('meta[property="og:title"]').attr('content') || '')
  const summary = cut(description || [headings.h1[0], ...paragraphs.slice(0, 2)].filter(Boolean).join(' — '), 700)
  const canonical = absolute($('link[rel="canonical"]').attr('href') || '', url)
  const ogImage = absolute($('meta[property="og:image"]').attr('content') || '', url)
  if (ogImage && !imageDetails.some(x => x.url === ogImage)) imageDetails.unshift({ url: ogImage, alt: 'Open Graph image', title: '', width: '', height: '', pageUrl: url })

  const dedupImages = []
  for (const img of imageDetails) if (!dedupImages.some(x => x.url === img.url)) dedupImages.push(img)
  const dedupCtas = []
  for (const cta of ctas) if (!dedupCtas.some(x => x.text === cta.text && x.url === cta.url)) dedupCtas.push(cta)

  return {
    url,
    type: pageType(new URL(url).pathname),
    title,
    description,
    summary,
    language: $('html').attr('lang') || '',
    canonical,
    openGraph: {
      title: cleanText($('meta[property="og:title"]').attr('content') || ''),
      description: cleanText($('meta[property="og:description"]').attr('content') || ''),
      image: ogImage,
      type: cleanText($('meta[property="og:type"]').attr('content') || '')
    },
    headings,
    paragraphs,
    importantHeadings: unique([...headings.h1, ...headings.h2]).slice(0, 20),
    ctas: dedupCtas.slice(0, 30),
    prices: unique(priceMatches).slice(0, 30),
    contacts: { emails: unique([...emails, ...visibleEmails]), phones: unique(phones), socials: unique(socials) },
    forms,
    internalLinks: unique(internal),
    externalLinks: unique(external),
    images: dedupImages.map(x => x.url),
    imageDetails: dedupImages,
    navigation,
    structuredDataTypes,
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0
  }
}

app.get('/api/health', (req, res) => res.json({ ok: true }))
app.post('/api/analyze', async (req, res) => {
  try {
    const start = normalizeInput(req.body.url)
    const maxPages = Math.min(20, Math.max(1, Number(req.body.maxPages) || 10))
    await assertPublic(start)
    const origin = start.origin
    let robots = null, robotsFound = false, sitemaps = []
    try {
      const rr = await safeFetch(new URL('/robots.txt', origin))
      if (rr.response.ok) {
        const txt = await rr.response.text()
        robots = robotsParser(new URL('/robots.txt', origin).toString(), txt)
        robotsFound = true
        sitemaps = txt.split(/\r?\n/).map(x => x.match(/^sitemap:\s*(.+)$/i)?.[1]?.trim()).filter(Boolean)
      }
    } catch {}

    const queue = [start.toString()], seen = new Set(), pages = [], skipped = []
    while (queue.length && pages.length < maxPages) {
      const candidate = queue.shift()
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const candidateUrl = new URL(candidate)
      if (candidateUrl.origin !== origin) continue
      if (robots && !robots.isAllowed(candidate, USER_AGENT)) { skipped.push({ url: candidate, reason: 'Disallowed by robots.txt' }); continue }
      try {
        const { response, url: finalUrl } = await safeFetch(candidate)
        if (!response.ok) { skipped.push({ url: candidate, reason: `HTTP ${response.status}` }); continue }
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('text/html')) { skipped.push({ url: candidate, reason: 'Not an HTML page' }); continue }
        const length = Number(response.headers.get('content-length') || 0)
        if (length > 5000000) { skipped.push({ url: candidate, reason: 'HTML page is too large' }); continue }
        const html = await response.text()
        const page = extract(html, finalUrl.toString(), origin)
        pages.push(page)
        for (const link of page.internalLinks) {
          if (queue.length + pages.length > 100) break
          if (!seen.has(link)) queue.push(link)
        }
      } catch (error) {
        skipped.push({ url: candidate, reason: error.name === 'AbortError' ? 'Timed out' : error.message })
      }
    }

    if (!pages.length) throw new Error('No public HTML pages could be analyzed.')
    const home = pages[0]
    const navigation = []
    for (const page of pages) for (const item of page.navigation) if (!navigation.some(x => x.url === item.url)) navigation.push(item)
    const imageDetails = []
    for (const page of pages) {
      for (const image of page.imageDetails) {
        const existing = imageDetails.find(x => x.url === image.url)
        if (existing) {
          if (!existing.alt && image.alt) existing.alt = image.alt
          if (!existing.title && image.title) existing.title = image.title
          if (!existing.pages.includes(page.url)) existing.pages.push(page.url)
        } else imageDetails.push({ ...image, pages: [page.url] })
      }
    }
    const contacts = {
      emails: unique(pages.flatMap(p => p.contacts.emails)),
      phones: unique(pages.flatMap(p => p.contacts.phones)),
      socials: unique(pages.flatMap(p => p.contacts.socials))
    }
    const important = {
      headings: unique(pages.flatMap(p => p.importantHeadings)).slice(0, 50),
      ctas: pages.flatMap(p => p.ctas).filter((x, i, all) => all.findIndex(y => y.text === x.text && y.url === x.url) === i).slice(0, 50),
      prices: unique(pages.flatMap(p => p.prices)).slice(0, 50),
      forms: pages.reduce((n, p) => n + p.forms.length, 0)
    }
    const internalLinks = unique(pages.flatMap(p => p.internalLinks))
    const externalLinks = unique(pages.flatMap(p => p.externalLinks))

    res.json({
      analyzedAt: new Date().toISOString(),
      finalHomeUrl: home.url,
      site: {
        hostname: new URL(home.url).hostname,
        origin,
        title: home.title,
        description: home.description,
        summary: home.summary,
        purpose: home.description || home.summary || home.headings.h1[0] || 'No clear public description found.',
        language: home.language,
        canonical: home.canonical,
        openGraph: home.openGraph
      },
      totals: {
        pages: pages.length,
        internalLinks: internalLinks.length,
        externalLinks: externalLinks.length,
        images: imageDetails.length,
        words: pages.reduce((n, p) => n + p.wordCount, 0),
        ctas: important.ctas.length
      },
      navigation: navigation.slice(0, 60),
      contacts,
      important,
      imageDetails,
      robots: { found: robotsFound, url: new URL('/robots.txt', origin).toString(), sitemaps },
      structure: pages.map(p => ({ url: p.url, path: new URL(p.url).pathname, title: p.title, type: p.type, wordCount: p.wordCount, summary: p.summary })),
      pages,
      skipped
    })
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not analyze this website.' })
  }
})

app.get('/robots.txt', (req, res) => {
  const base = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`)
})
app.get('/sitemap.xml', (req, res) => {
  const base = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`
  const paths = ['/', '/website-analyzer', '/website-structure-analyzer', '/website-link-analyzer', '/how-it-works', '/faq', '/privacy', '/terms']
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`)
})
app.use(express.static(dist, { extensions: ['html'] }))
app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next()
  try {
    const route = req.path === '/' ? '' : req.path.replace(/^\//, '')
    const file = route ? path.join(dist, route, 'index.html') : path.join(dist, 'index.html')
    let html = await readFile(file, 'utf8').catch(() => readFile(path.join(dist, 'index.html'), 'utf8'))
    const base = process.env.PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`
    html = html.replaceAll('__SITE_ORIGIN__', base)
    res.type('html').send(html)
  } catch { res.status(404).send('Not found') }
})
app.listen(PORT, () => console.log(`SiteScope running on ${PORT}`))
