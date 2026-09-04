# SiteScope — SEO-ready Website Structure Analyzer

SiteScope is a website-first crawler/analyzer that turns a public URL into an organized report. This version includes the public SEO site and the working analyzer API in one project.

## Public pages included
- `/` — SEO homepage
- `/website-analyzer` — main interactive analyzer
- `/website-structure-analyzer` — focused SEO landing page
- `/website-link-analyzer` — focused SEO landing page
- `/how-it-works` — crawler explanation
- `/faq` — FAQ + FAQ structured data
- `/privacy` — privacy policy
- `/terms` — terms of use
- `/sitemap.xml` — generated automatically from the live host
- `/robots.txt` — generated automatically and points to the live sitemap

The production build prerenders the public routes into crawlable HTML with unique titles, descriptions, canonical URLs, Open Graph metadata, internal links and Schema.org JSON-LD. The Node server replaces the site-origin placeholder with the real deployed origin at request time.

## Analyzer features
- Crawl 5–20 same-site HTML pages
- Respect `robots.txt`
- Extract navigation and discovered page structure
- Titles, meta descriptions, H1/H2/H3, canonical and language
- Internal/external links
- Images
- Public `mailto:` / `tel:` contact details and common social links
- JSON-LD type detection
- Sitemap declarations from the target website's robots.txt
- Export complete analysis as JSON
- SSRF protections: blocks localhost/private IP ranges and re-validates redirects
- Basic server-side request limiting: 30 analyses per IP per hour
- No public result URL is created for analyzed websites

## Run locally

Requirements: Node.js 20.19+ or Node.js 22+

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

The crawler API runs on port `8787`. Vite proxies `/api`, `/sitemap.xml` and `/robots.txt` during development.

## Production

Build and prerender the frontend:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

Then open port `8787` or let your host provide the `PORT` environment variable. In production the same Node/Express service hosts the built website, SEO pages, sitemap, robots.txt and crawler API.

## Deploy on Render

A `render.yaml` is included. Push this folder to GitHub, create a Render Blueprint/Web Service from the repository, and Render can use the included build/start commands.

After connecting a real domain:
1. Set `PUBLIC_ORIGIN=https://yourdomain.com` on the host so canonical and sitemap URLs are fixed to your preferred domain.
2. Confirm HTTPS works.
3. Open `/sitemap.xml` and verify the URLs show your real domain.
4. Add the domain/property to Google Search Console.
5. Submit `https://YOUR-DOMAIN/sitemap.xml` in Search Console.
6. Use URL Inspection on the homepage and `/website-analyzer` after deployment.

## Important crawler behavior

SiteScope only crawls public HTTP/HTTPS pages. It does not bypass authentication, CAPTCHAs, paywalls or private network restrictions. The first version caps each crawl at 20 HTML pages.

## Before charging users

Add persistent accounts/database, stronger distributed rate limiting, usage quotas, logging/monitoring, a support/contact address, finalized legal text for your business jurisdiction, and abuse reporting.
