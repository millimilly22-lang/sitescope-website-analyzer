import { useEffect, useMemo, useState } from 'react'
import { Search, Globe2, Network, FileText, Link2, Images, Download, Copy, Check, ExternalLink, Sparkles, Phone, Mail, MousePointerClick } from 'lucide-react'

const routes = {
  '/': ['See how a website is structured in seconds.','Paste a public URL and SiteScope organizes pages, navigation, headings, links, images and metadata.'],
  '/website-structure-analyzer': ['Website Structure Analyzer','Map public pages, navigation and headings from one URL.'],
  '/website-link-analyzer': ['Website Link Analyzer','Separate internal and external links from public website pages.'],
  '/how-it-works': ['How SiteScope works','SiteScope follows permitted same-site HTML pages, respects robots.txt and organizes what it finds.'],
  '/faq': ['Website Analyzer FAQ','SiteScope analyzes public pages only, does not bypass logins or paywalls, and caps each crawl at 20 pages.'],
  '/privacy': ['Privacy Policy','Submitted URLs are used to produce the requested analysis. No public result page is created for submitted websites.'],
  '/terms': ['Terms of Use','Use SiteScope lawfully for public web content and websites you are authorized to inspect.']
}

function Header(){return <header><a className="brand" href="/"><Network size={20}/> SiteScope</a><nav><a href="/website-analyzer">Analyzer</a><a href="/how-it-works">How it works</a><a href="/faq">FAQ</a></nav></header>}
function Footer(){return <footer>© {new Date().getFullYear()} SiteScope · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/sitemap.xml">Sitemap</a></footer>}
function Shell({children}){return <div className="app"><Header/><main>{children}</main><Footer/></div>}
function StaticPage({title,text}){return <Shell><section className="hero simple"><span className="eyebrow">PUBLIC WEBSITE ANALYSIS</span><h1>{title}</h1><p>{text}</p><a className="cta" href="/website-analyzer">Open website analyzer →</a></section><section className="cards"><Card icon={Network} title="Structure" text="Pages, paths and navigation in a readable order."/><Card icon={FileText} title="Content" text="Titles, descriptions and important headings."/><Card icon={Link2} title="Links" text="Internal and external links separated clearly."/></section></Shell>}
function Card({icon:Icon,title,text}){return <article className="card"><Icon size={22}/><h3>{title}</h3><p>{text}</p></article>}
function Stat({n,t}){return <div><b>{n}</b><span>{t}</span></div>}
function Panel({title,children,className=''}){return <section className={`panel ${className}`}><h3>{title}</h3>{children}</section>}
function Info({label,value}){return <div className="info"><b>{label}</b><span className="break">{String(value)}</span></div>}
function Empty({children='Nothing found on the analyzed public pages.'}){return <p className="empty">{children}</p>}

function SearchForm({url,setUrl,maxPages,setMaxPages,onSubmit,loading,compact=false}){
 return <form className={`search ${compact?'compact':''}`} onSubmit={onSubmit}>
  <Globe2 className="search-icon" size={20}/>
  <input aria-label="Website URL" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck="false" value={url} onChange={e=>setUrl(e.target.value)} placeholder="Paste website link, e.g. example.com"/>
  {setMaxPages&&<select aria-label="Pages to analyze" value={maxPages} onChange={e=>setMaxPages(e.target.value)}><option value="5">5 pages</option><option value="10">10 pages</option><option value="15">15 pages</option><option value="20">20 pages</option></select>}
  <button type="submit" disabled={loading||!url.trim()}><Search size={18}/>{loading?'Analyzing…':'Analyze website'}</button>
 </form>
}

function Home(){
 const [url,setUrl]=useState('')
 function go(e){e.preventDefault();if(!url.trim())return;window.location.href=`/website-analyzer?url=${encodeURIComponent(url.trim())}`}
 return <Shell><section className="hero home-hero"><span className="eyebrow">WEBSITE INFORMATION, ORGANIZED</span><h1>Paste a website link.<br/><em>See what is inside.</em></h1><p>Get the site's purpose, pages, important content, navigation, links, contact details, calls to action and discovered images in one organized report.</p><SearchForm url={url} setUrl={setUrl} onSubmit={go} loading={false} compact/></section><section className="cards"><Card icon={Sparkles} title="Important details" text="Purpose, descriptions, key headings, prices and calls to action."/><Card icon={Network} title="Structure" text="Pages, paths and main navigation."/><Card icon={FileText} title="Page details" text="Summaries, headings, forms and content signals."/><Card icon={Images} title="Image gallery" text="Discovered images with alt text and source pages."/></section></Shell>
}

function Analyzer(){
 const initialUrl = new URLSearchParams(window.location.search).get('url') || ''
 const [url,setUrl]=useState(initialUrl)
 const [maxPages,setMaxPages]=useState(10)
 const [data,setData]=useState(null)
 const [loading,setLoading]=useState(false)
 const [error,setError]=useState('')
 const [tab,setTab]=useState('Overview')
 const [copied,setCopied]=useState(false)
 const internal=useMemo(()=>data?[...new Set(data.pages.flatMap(p=>p.internalLinks||[]))]:[],[data])
 const external=useMemo(()=>data?[...new Set(data.pages.flatMap(p=>p.externalLinks||[]))]:[],[data])
 const images=useMemo(()=>data?(data.imageDetails||data.pages.flatMap(p=>(p.images||[]).map(x=>({url:x,alt:'',pages:[p.url]})))):[],[data])

 useEffect(()=>{if(initialUrl) analyze(initialUrl)},[])
 async function analyze(target=url){
  const value=String(target||'').trim();if(!value)return
  setLoading(true);setError('');setData(null);setTab('Overview')
  try{const r=await fetch('/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:value,maxPages:Number(maxPages)})});const b=await r.json();if(!r.ok)throw new Error(b.error||'Analysis failed');setData(b)}catch(err){setError(err.message)}finally{setLoading(false)}
 }
 function run(e){e.preventDefault();analyze(url)}
 async function copy(){await navigator.clipboard.writeText(JSON.stringify(data,null,2));setCopied(true);setTimeout(()=>setCopied(false),1200)}
 function download(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download=`${data.site.hostname}-analysis.json`;a.click();URL.revokeObjectURL(a.href)}
 const tabs=['Overview','Important','Structure','Pages','Links','Images','Technical']

 return <Shell><section className="hero analyzer-hero"><span className="eyebrow">PUBLIC WEBSITE ANALYZER</span><h1>Paste a link.<br/><em>Get the full picture.</em></h1><p>SiteScope reads permitted public pages and organizes the website's purpose, important content, structure, links, images and technical details.</p><SearchForm url={url} setUrl={setUrl} maxPages={maxPages} setMaxPages={setMaxPages} onSubmit={run} loading={loading}/>{error&&<div className="error">{error}</div>}</section>
 {!data&&!loading&&<section className="cards"><Card icon={Sparkles} title="Important details" text="Purpose, headings, prices, CTAs and contact details."/><Card icon={Network} title="Site structure" text="Discover same-site pages and navigation."/><Card icon={FileText} title="Page details" text="Descriptions, summaries, headings and forms."/><Card icon={Images} title="Images" text="View discovered images, alt text and source pages."/></section>}
 {loading&&<div className="loading"><b>Analyzing website…</b><span>Following permitted public pages and organizing the details.</span></div>}
 {data&&<section className="results"><div className="resulthead"><div><span className="eyebrow">ANALYSIS COMPLETE</span><h2>{data.site.title||data.site.hostname}</h2><a href={data.finalHomeUrl} target="_blank" rel="noreferrer">{data.site.hostname} <ExternalLink size={13}/></a></div><div className="actions"><button onClick={copy}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'Copied':'Copy JSON'}</button><button onClick={download}><Download size={16}/> Export JSON</button></div></div>
 <div className="stats"><Stat n={data.totals.pages} t="Pages"/><Stat n={data.totals.images} t="Images"/><Stat n={data.totals.internalLinks} t="Internal links"/><Stat n={data.totals.ctas||0} t="Calls to action"/></div>
 <div className="tabs">{tabs.map(x=><button type="button" className={tab===x?'active':''} onClick={()=>setTab(x)} key={x}>{x}</button>)}</div>

 {tab==='Overview'&&<div className="grid"><Panel title="What this website appears to do" className="wide-mobile"><p className="lead-copy">{data.site.purpose||data.site.description||data.site.summary||'No clear public description was found.'}</p><Info label="Website" value={data.site.hostname}/><Info label="Title" value={data.site.title||'Not found'}/><Info label="Language" value={data.site.language||'Not declared'}/><Info label="Canonical" value={data.site.canonical||'Not found'}/></Panel><Panel title="Main navigation">{data.navigation.length?data.navigation.map((x,i)=><a className="row" key={`${x.url}-${i}`} href={x.url} target="_blank" rel="noreferrer">{x.text}</a>):<Empty/>}</Panel><Panel title="Contact details">{data.contacts?.emails?.length?data.contacts.emails.map(x=><div className="detail-row" key={x}><Mail size={16}/><span>{x}</span></div>):null}{data.contacts?.phones?.length?data.contacts.phones.map(x=><div className="detail-row" key={x}><Phone size={16}/><span>{x}</span></div>):null}{data.contacts?.socials?.length?data.contacts.socials.map(x=><a className="row break" key={x} href={x} target="_blank" rel="noreferrer">{x}</a>):(!data.contacts?.emails?.length&&!data.contacts?.phones?.length&&<Empty/>)}</Panel><Panel title="At a glance"><Info label="Words scanned" value={data.totals.words||0}/><Info label="External links" value={data.totals.externalLinks}/><Info label="Images" value={data.totals.images}/><Info label="Skipped URLs" value={data.skipped?.length||0}/></Panel></div>}

 {tab==='Important'&&<div className="grid"><Panel title="Important headings">{data.important?.headings?.length?data.important.headings.map((x,i)=><div className="important-item" key={`${x}-${i}`}>{x}</div>):<Empty/>}</Panel><Panel title="Calls to action">{data.important?.ctas?.length?data.important.ctas.map((x,i)=><div className="cta-row" key={`${x.text}-${i}`}><MousePointerClick size={16}/><div><strong>{x.text}</strong>{x.url&&<a className="break" href={x.url} target="_blank" rel="noreferrer">{x.url}</a>}</div></div>):<Empty/>}</Panel><Panel title="Prices / amounts found">{data.important?.prices?.length?<div className="tag-list">{data.important.prices.map((x,i)=><span className="tag" key={`${x}-${i}`}>{x}</span>)}</div>:<Empty>No obvious public prices were detected.</Empty>}</Panel><Panel title="Forms and interactions"><Info label="Forms detected" value={data.important?.forms||0}/><Info label="CTAs detected" value={data.important?.ctas?.length||0}/><p>These counts come from the public HTML SiteScope could access.</p></Panel></div>}

 {tab==='Structure'&&<Panel title="Website structure">{data.structure.map((p,i)=><div className="tree" key={p.url}><b>{String(i+1).padStart(2,'0')}</b><div><strong>{p.title||p.path}</strong><span>{p.path}</span>{p.summary&&<small className="tree-summary">{p.summary}</small>}</div><small className="type-pill">{p.type}</small></div>)}</Panel>}

 {tab==='Pages'&&<div className="pages">{data.pages.map((p,i)=><article className="page" key={p.url}><small>PAGE {i+1} · {String(p.type||'page').toUpperCase()}</small><h3>{p.title||'Untitled page'}</h3><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a><p className="page-summary">{p.summary||p.description||'No useful public summary was detected.'}</p><div className="mini"><span>{p.wordCount} words</span><span>{p.images?.length||0} images</span><span>{p.internalLinks?.length||0} internal links</span><span>{p.forms?.length||0} forms</span></div>{p.headings?.h1?.length>0&&<div className="page-section"><b>H1</b>{p.headings.h1.map((x,j)=><div key={j}>{x}</div>)}</div>}{p.headings?.h2?.length>0&&<div className="page-section"><b>Important sections</b>{p.headings.h2.slice(0,8).map((x,j)=><div key={j}>{x}</div>)}</div>}{p.ctas?.length>0&&<div className="page-section"><b>Calls to action</b><div className="tag-list">{p.ctas.slice(0,8).map((x,j)=><span className="tag" key={j}>{x.text}</span>)}</div></div>}</article>)}</div>}

 {tab==='Links'&&<div className="grid"><Panel title={`Internal links (${internal.length})`}>{internal.length?internal.map(x=><a className="row break" key={x} href={x} target="_blank" rel="noreferrer">{x}</a>):<Empty/>}</Panel><Panel title={`External links (${external.length})`}>{external.length?external.map(x=><a className="row break" key={x} href={x} target="_blank" rel="noreferrer">{x}</a>):<Empty/>}</Panel></div>}

 {tab==='Images'&&<Panel title={`Discovered images (${images.length})`}><p className="panel-intro">Images are grouped from the public pages SiteScope analyzed. Some sites block hotlink previews; the image URL and source page are still shown.</p>{images.length?<div className="image-grid">{images.map((img,i)=><article className="image-card" key={`${img.url}-${i}`}><a className="image-preview" href={img.url} target="_blank" rel="noreferrer"><img src={img.url} loading="lazy" alt={img.alt||'Discovered website image'} onError={e=>{e.currentTarget.style.display='none';e.currentTarget.parentElement.classList.add('image-failed')}}/></a><div className="image-meta"><strong>{img.alt||img.title||'Image with no alt text'}</strong>{(img.width||img.height)&&<span>{img.width||'?'} × {img.height||'?'}</span>}<a className="break" href={img.url} target="_blank" rel="noreferrer">Open image</a>{(img.pages||[img.pageUrl]).filter(Boolean).slice(0,2).map((p,j)=><a className="source-link break" href={p} target="_blank" rel="noreferrer" key={j}>Source: {p}</a>)}</div></article>)}</div>:<Empty/>}</Panel>}

 {tab==='Technical'&&<div className="grid"><Panel title="Technical"><Info label="Origin" value={data.site.origin}/><Info label="robots.txt" value={data.robots.found?'Found':'Not found'}/><Info label="Sitemaps" value={data.robots.sitemaps.length||'None declared'}/><Info label="Skipped URLs" value={data.skipped.length}/></Panel><Panel title="Structured data">{[...new Set(data.pages.flatMap(p=>p.structuredDataTypes||[]))].length?[...new Set(data.pages.flatMap(p=>p.structuredDataTypes||[]))].map(x=><span className="tag" key={x}>{x}</span>):<Empty/>}</Panel><Panel title="Open Graph"><Info label="Title" value={data.site.openGraph?.title||'Not found'}/><Info label="Type" value={data.site.openGraph?.type||'Not found'}/><Info label="Image" value={data.site.openGraph?.image||'Not found'}/></Panel><Panel title="Crawl notes">{data.skipped?.length?data.skipped.slice(0,20).map((x,i)=><div className="skip-row" key={i}><b>{x.reason}</b><span className="break">{x.url}</span></div>):<Empty>No skipped URLs.</Empty>}</Panel></div>}
 </section>}
 </Shell>
}

export default function App(){const p=window.location.pathname.replace(/\/+$/,'')||'/';if(p==='/website-analyzer')return <Analyzer/>;if(p==='/')return <Home/>;if(routes[p])return <StaticPage title={routes[p][0]} text={routes[p][1]}/>;return <StaticPage title="Page not found" text="Return to the SiteScope homepage or open the analyzer."/>}
