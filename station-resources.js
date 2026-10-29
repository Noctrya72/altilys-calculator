const DDG_HTML = "https://html.duckduckgo.com/html/";
const RESULT_CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SEARCH_RESULTS = 12;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers}
  });
}

function normalizeText(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function decodeHtml(value = "") {
  const named = {amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", ccedil: "ç", nbsp: " "};
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (all, key) => named[key] ?? all);
}

function stripTags(value = "") {
  return decodeHtml(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function safePublicUrl(value, base = "https://html.duckduckgo.com/") {
  try {
    const url = new URL(decodeHtml(value).replace(/^\/\//, "https://"), base);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") return null;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) return null;
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
      const wrapped = url.searchParams.get("uddg");
      if (!wrapped) return null;
      return safePublicUrl(wrapped, "https://html.duckduckgo.com/");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isPdfUrl(value = "") {
  try { return /\.pdf$/i.test(new URL(value).pathname); }
  catch { return /\.pdf(?:[?#]|$)/i.test(value); }
}

function extractSearchResults(html) {
  const results = [];
  const anchorRegex = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) && results.length < MAX_SEARCH_RESULTS) {
    const start = Math.max(0, html.lastIndexOf('class="result ', match.index));
    let end = html.indexOf('class="result ', match.index + match[0].length);
    if (end < 0 || end - start > 16000) end = Math.min(html.length, match.index + 7000);
    const block = html.slice(start, end);
    const snippetMatch = block.match(/<(?:a|div|span)\b(?=[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const url = safePublicUrl(match[1]);
    if (!url || url.includes("html.duckduckgo.com/html/")) continue;
    const title = stripTags(match[2]);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    if (!title) continue;
    results.push({url, title, snippet, source: "DuckDuckGo"});
  }
  return dedupe(results);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchText(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.6",
        "User-Agent": "Mozilla/5.0 (compatible; RepereGPSResourceFinder/1.0; +https://developers.cloudflare.com/pages/)"
      },
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`Recherche HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query) {
  const url = new URL(DDG_HTML);
  url.searchParams.set("q", query);
  url.searchParams.set("kl", "fr-fr");
  const html = await fetchText(url.toString(), 11000);
  if (/anomaly.js|bots use duckduckgo|select all squares/i.test(html) && !html.includes("result__a")) {
    throw new Error("Le moteur de recherche demande une vérification anti-robot.");
  }
  return extractSearchResults(html);
}

function stationTokens(station) {
  return normalizeText(station).split(/[^a-z0-9]+/).filter(token => (token.length >= 3 || /^\d$/.test(token)) && !["les", "des", "sur", "aux", "dans", "une", "du", "the", "station", "domaine", "skiable", "france", "hiver", "officiel"].includes(token));
}

function urlHost(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function resultText(result) {
  return normalizeText(`${result.title || ""} ${result.snippet || ""} ${result.url || ""}`);
}

function officialScore(result, station, index) {
  const text = resultText(result);
  const host = urlHost(result.url);
  let score = 14 - index * 1.7;
  const tokens = stationTokens(station);
  score += tokens.filter(token => text.includes(token)).length * 4;
  if (/site officiel|officiel|official|office de tourisme|tourisme officiel/.test(text)) score += 24;
  if (/\/hiver(?:\/|$)|\/winter(?:\/|$)|hiver|winter|ski/.test(text)) score += 17;
  let path = "";
  try { path = new URL(result.url).pathname; } catch {}
  if (/^\/(?:hiver|winter)\/?$/i.test(path)) score += 28;
  else if (path === "/") score += /accueil|home(?:page)?/.test(text) ? 8 : 2;
  else score -= Math.max(0, path.split("/").filter(Boolean).length - 1) * 2;
  if (/accueil|home(?:page)?|destination/.test(text)) score += 4;
  if (/facebook\.com|instagram\.com|youtube\.com|tiktok\.com|tripadvisor\.|booking\.com|snow-forecast\.|onthesnow\.|wikipedia\.org|skiinfo\./.test(host)) score -= 35;
  if (/webcam|plan-des-pistes|plan des pistes|filetype|\.pdf/.test(text)) score -= 18;
  if (/forum|avis voyageurs|comparateur|location de vacances/.test(text)) score -= 12;
  if (/office de tourisme|skipass|remontees|remontees-mecaniques/.test(host)) score += 3;
  return score;
}

function pickOfficial(results, station) {
  const ranked = results
    .filter(result => !isPdfUrl(result.url) && !/facebook\.com|instagram\.com|youtube\.com|tiktok\.com|google\.|duckduckgo\.com/.test(urlHost(result.url)))
    .map((result, index) => ({...result, score: officialScore(result, station, index)}))
    .sort((a, b) => b.score - a.score);
  const chosen = ranked[0];
  if (!chosen || chosen.score < 8) return {chosen: null, alternatives: ranked.slice(0, 3)};
  const text = resultText(chosen);
  const winter = /\/hiver(?:\/|$)|\/winter(?:\/|$)|hiver|winter/.test(text);
  return {
    chosen: {...chosen, label: winter ? "Site officiel probable · version hiver détectée" : "Site officiel probable · version hiver non confirmée"},
    alternatives: ranked.slice(1, 4)
  };
}

function webcamScope(result) {
  const text = resultText(result);
  const fullDomain = /toutes les webcams|webcams? (?:du|de) domaine skiable|webcams? du domaine(?: skiable)?|webcams? (?:de|du|sur) (?:tout )?le domaine|ensemble des webcams|ensemble du domaine|tout le domaine skiable|tous les secteurs|all webcams|ski area webcams|webcams sur l.?ensemble du domaine/.test(text);
  if (fullDomain) {
    return {scope: "full", scopeLabel: "Tout le domaine skiable (mention détectée)", scopeReason: "Le titre ou l’extrait indique une couverture globale. Vérifie malgré tout la page."};
  }
  const partial = /secteur|sommet|front de neige|village|quartier|une webcam|webcam du [a-z]|webcam de [a-z]/.test(text);
  if (partial) {
    return {scope: "partial", scopeLabel: "Couverture partielle ou secteur ciblé", scopeReason: "Le résultat semble viser un secteur précis plutôt que l’ensemble du domaine."};
  }
  return {scope: "unknown", scopeLabel: "Couverture non confirmée", scopeReason: "Le résultat ne permet pas de confirmer si toutes les zones du domaine sont couvertes."};
}

function webcamScore(result, station, index, officialUrl = "") {
  const text = resultText(result);
  let score = 15 - index * 2;
  score += stationTokens(station).filter(token => text.includes(token)).length * 3;
  if (/webcam|livecam|live cam|cam[ée]ra en direct|cams en direct/.test(text)) score += 23;
  else score -= 20;
  if (/domaine skiable|toutes les webcams|tout le domaine|tous les secteurs|webcams du domaine/.test(text)) score += 13;
  if (/hiver|winter|ski/.test(text)) score += 4;
  if (/instagram\.com|facebook\.com|youtube\.com|tiktok\.com|wikipedia\.org/.test(urlHost(result.url))) score -= 25;
  if (/photo archivee|ancienne webcam|archive webcam/.test(text)) score -= 10;
  return score;
}

function pickWebcam(results, station, officialUrl = "") {
  const ranked = results
    .map((result, index) => ({...result, score: webcamScore(result, station, index, officialUrl)}))
    .sort((a, b) => b.score - a.score);
  const chosen = ranked[0];
  if (!chosen || chosen.score < 15) return {chosen: null, alternatives: ranked.slice(0, 3)};
  return {chosen: {...chosen, ...webcamScope(chosen), label: webcamScope(chosen).scopeLabel}, alternatives: ranked.slice(1, 4)};
}

function findSeason(item) {
  const text = `${item.title || ""} ${item.url || ""} ${item.snippet || ""}`;
  const season = text.match(/\b(20\d{2})\s*[-/–]\s*(?:(20)?(\d{2}))\b/);
  if (season) {
    const start = Number(season[1]);
    const endShort = season[3];
    const end = season[2] ? Number(`${season[2]}${endShort}`) : (Number(endShort) < 100 ? Math.floor(start / 100) * 100 + Number(endShort) : Number(endShort));
    return {year: start, label: `Saison hiver ${start}/${String(end).slice(-2)}`};
  }
  const years = [...text.matchAll(/\b20\d{2}\b/g)].map(match => Number(match[0]));
  if (years.length) {
    const year = Math.max(...years);
    return {year, label: `Document daté ${year} (saison à confirmer)`};
  }
  return {year: 0, label: "Saison non détectée"};
}

function pdfScore(item, station, index = 0, officialUrl = "") {
  const text = resultText(item);
  const isPistePlan = /plans?[-_ ]des?[-_ ]pistes?|plans?[-_ ]pistes?|piste map|ski[-_ ]map|plans?[-_ ](?:du[-_ ]?)?domaine|plan[-_ ]hiver|plan_hiver/.test(text);
  if (!isPistePlan) return -100;
  let score = 8 - index * 1.4;
  score += 22;
  if (/hiver|winter|ski/.test(text)) score += 9;
  if (/ete|été|summer|bike.?park|vtt|randonnee|randonnée|pedestre|piéton/.test(text)) score -= 45;
  if (/snowpark/.test(text) && !/plan des pistes|plan du domaine/.test(text)) score -= 20;
  score += stationTokens(station).filter(token => text.includes(token)).length * 2;
  const officialHost = urlHost(officialUrl);
  if (officialHost && (urlHost(item.url) === officialHost || urlHost(item.url).endsWith(`.${officialHost}`))) score += 5;
  return score;
}

function makePdfCandidate(url, title, snippet, sourceOrder = 0) {
  const safe = safePublicUrl(url, url);
  if (!safe || !isPdfUrl(safe)) return null;
  const season = findSeason({url: safe, title, snippet});
  return {url: safe, title: title || "Plan des pistes PDF", snippet: snippet || "Fichier PDF trouvé dans les résultats de recherche.", seasonYear: season.year, seasonLabel: season.label, score: 0, sourceOrder};
}

function extractPageTitle(html) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripTags(title[1]) : "Page de plan des pistes";
}

function extractPdfAnchors(html, pageUrl, titleSeed = "") {
  const anchors = /<a\b([^>]*?)\bhref=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const found = [];
  let match;
  while ((match = anchors.exec(html)) && found.length < 40) {
    const href = decodeHtml(match[2]);
    let absolute;
    try { absolute = new URL(href, pageUrl).toString(); } catch { continue; }
    const safe = safePublicUrl(absolute, pageUrl);
    if (!safe || !isPdfUrl(safe)) continue;
    const title = stripTags(match[4]) || titleSeed || extractPageTitle(html);
    found.push(makePdfCandidate(safe, title, `${titleSeed || extractPageTitle(html)} · lien PDF extrait de la page`, found.length));
  }
  return found.filter(Boolean);
}

async function collectPdfCandidates(results) {
  const candidates = [];
  for (let index = 0; index < results.length; index++) {
    const item = results[index];
    if (isPdfUrl(item.url)) {
      const candidate = makePdfCandidate(item.url, item.title, item.snippet, index);
      if (candidate) candidates.push(candidate);
    }
  }
  // Some search results are official HTML pages linking to a PDF instead of the PDF itself.
  const pages = results.filter(item => !isPdfUrl(item.url) && /plan|piste|ski map|domaine skiable/i.test(`${item.title} ${item.snippet}`)).slice(0, 3);
  const crawled = await Promise.allSettled(pages.map(async (page, index) => {
    const html = await fetchText(page.url, 6000);
    return extractPdfAnchors(html, page.url, page.title).map(item => ({...item, sourceOrder: 100 + index * 10 + item.sourceOrder}));
  }));
  for (const result of crawled) if (result.status === "fulfilled") candidates.push(...result.value);
  return dedupe(candidates.map(item => ({...item, key: item.url}))).map(({key, ...item}) => item);
}

function pickLatestPdf(candidates, station, officialUrl = "") {
  const ranked = candidates
    .filter(item => isPdfUrl(item.url))
    .map(item => ({...item, score: pdfScore(item, station, item.sourceOrder, officialUrl)}))
    .filter(item => item.score > 0)
    .sort((a, b) => (b.seasonYear - a.seasonYear) || (b.score - a.score) || (a.sourceOrder - b.sourceOrder));
  const chosen = ranked[0];
  if (!chosen) return {chosen: null, alternatives: []};
  return {
    chosen: {...chosen, label: "Fichier PDF direct", seasonLabel: chosen.seasonLabel || "Saison non détectée"},
    alternatives: ranked.slice(1, 4).map(item => ({...item, label: item.seasonLabel || "Saison non détectée"}))
  };
}

function currentWinterSeason() {
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return {startYear, label: `${startYear}/${String(startYear + 1).slice(-2)}`};
}

function normalizeForOutput(resource) {
  if (!resource) return null;
  return {url: resource.url, title: resource.title || resource.url, snippet: resource.snippet || "", label: resource.label || "Résultat à vérifier", source: resource.source || "DuckDuckGo"};
}

export async function onRequestPost({request}) {
  if (request.method !== "POST") return json({error: "Méthode non autorisée. Utilise POST."}, 405, {Allow: "POST"});
  let payload;
  try {
    const text = await request.text();
    if (text.length > 8000) return json({error: "Requête trop volumineuse."}, 413);
    payload = JSON.parse(text);
  } catch {
    return json({error: "Corps JSON invalide."}, 400);
  }

  const station = String(payload?.station ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (station.length < 2 || station.length > 100) return json({error: "Le nom de station doit contenir entre 2 et 100 caractères."}, 400);
  if (/https?:\/\//i.test(station)) return json({error: "Entre un nom de station, pas une URL."}, 400);

  const cacheKey = normalizeText(station);
  const cached = RESULT_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return json({...cached.data, cached: true}, 200, {"Cache-Control": "public, max-age=300"});

  const season = currentWinterSeason();
  const queries = {
    official: `"${station}" station ski site officiel hiver`,
    webcam: `"${station}" webcams domaine skiable station`,
    plan: `"${station}" plan des pistes hiver ${season.startYear}/${season.startYear + 1} filetype:pdf`
  };
  const settled = await Promise.allSettled(Object.entries(queries).map(async ([key, query]) => [key, await searchWeb(query)]));
  const resultSets = {official: [], webcam: [], plan: []};
  const searchErrors = [];
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    if (result.status === "fulfilled") {
      const [key, items] = result.value;
      resultSets[key] = items;
    } else {
      searchErrors.push(`${Object.keys(queries)[index]} : ${String(result.reason?.message || result.reason)}`);
    }
  }

  let official = pickOfficial(resultSets.official, station);
  let webcam = pickWebcam(resultSets.webcam, station, official.chosen?.url || "");
  let pdfCandidates = await collectPdfCandidates(resultSets.plan);

  if (!pdfCandidates.length) {
    try {
      const fallbackResults = await searchWeb(`"${station}" plan des pistes filetype:pdf hiver`);
      resultSets.plan.push(...fallbackResults);
      pdfCandidates = await collectPdfCandidates(fallbackResults);
    } catch (error) {
      searchErrors.push(`plan PDF complémentaire : ${String(error?.message || error)}`);
    }
  }
  const plan = pickLatestPdf(pdfCandidates, station, official.chosen?.url || "");

  const data = {
    station,
    generatedAt: new Date().toISOString(),
    searchProvider: "DuckDuckGo HTML — résultats publics sans clé API",
    currentWinterSeason: season.label,
    official: normalizeForOutput(official.chosen),
    webcam: webcam.chosen ? {...normalizeForOutput(webcam.chosen), scope: webcam.chosen.scope, scopeLabel: webcam.chosen.scopeLabel, scopeReason: webcam.chosen.scopeReason} : null,
    plan: plan.chosen ? {...normalizeForOutput(plan.chosen), seasonYear: plan.chosen.seasonYear, seasonLabel: plan.chosen.seasonLabel} : null,
    alternatives: {
      official: official.alternatives.map(normalizeForOutput).filter(Boolean),
      webcam: webcam.alternatives.map(normalizeForOutput).filter(Boolean),
      plan: plan.alternatives.map(normalizeForOutput).filter(Boolean)
    },
    searchUrls: {
      official: `https://duckduckgo.com/?q=${encodeURIComponent(queries.official)}`,
      webcam: `https://duckduckgo.com/?q=${encodeURIComponent(queries.webcam)}`,
      plan: `https://duckduckgo.com/?q=${encodeURIComponent(queries.plan)}`
    },
    warnings: searchErrors
  };

  if (!data.official && !data.webcam && !data.plan) {
    return json({error: "Le moteur public n’a retourné aucun résultat exploitable. Réessaie plus tard ou ouvre les recherches manuelles.", details: searchErrors}, 502);
  }
  RESULT_CACHE.set(cacheKey, {at: Date.now(), data});
  while (RESULT_CACHE.size > 100) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
  return json(data, 200, {"Cache-Control": "public, max-age=300"});
}
