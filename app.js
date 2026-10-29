const DATA_URL = "./stations.json";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MAX_MATCH_DISTANCE_KM = 45;
const $ = (selector) => document.querySelector(selector);
let stations = [];
let currentCandidates = [];
let currentStation = null;
const geocodeCache = new Map();
let lastNominatimRequestAt = 0;
let map = null;
let mapMarker = null;

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatCoord(n) { return Number(n).toFixed(6); }
function coordDecimals(n) {
  const text = String(n);
  return text.includes(".") ? text.split(".")[1].length : 0;
}
function parseCoordinates(raw) {
  const text = raw.trim().replace(/−/g, "-");
  let match = text.match(/lat(?:itude)?\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]+\s*(?:lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (match) return {lat: Number(match[1].replace(",", ".")), lon: Number(match[2].replace(",", "."))};
  match = text.match(/(?:lon(?:gitude)?|lng)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)\s*[,; ]+\s*lat(?:itude)?\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/i);
  if (match) return {lat: Number(match[2].replace(",", ".")), lon: Number(match[1].replace(",", "."))};
  match = text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (match) return {lat:Number(match[1]), lon:Number(match[2])};
  // Two decimal numbers separated by comma/semicolon/space; avoids ambiguity in decimal commas.
  match = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]+\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (match) return {lat:Number(match[1]), lon:Number(match[2])};
  throw new Error("Format non reconnu. Utilise par exemple : lat: 45.889, lon: 6.735");
}
function validateCoordinates(point) {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
    throw new Error("Coordonnées invalides : latitude entre -90 et 90, longitude entre -180 et 180.");
  }
}
function setStatus(message, mode = "") {
  const status = $("#status"); status.textContent = message; status.className = `status ${mode}`.trim();
}
function stationCandidates(point) {
  return stations.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map(s => ({...s, distanceKm:haversineKm(point.lat,point.lon,s.lat,s.lon)}))
    .sort((a,b)=>a.distanceKm-b.distanceKm)
    .filter(s=>s.distanceKm<=MAX_MATCH_DISTANCE_KM).slice(0,5);
}
function initMap() {
  map = L.map("map", {scrollWheelZoom:true}).setView([45.4,6.2],7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(map);
  map.on("tileerror", () => {
    $("#map-caption").textContent = "Le fond de carte ne répond pas dans cet environnement. Les coordonnées calculées restent disponibles ; essaie la version publiée sur GitHub Pages ou ouvre la carte dans OpenStreetMap.";
  });
}
function updateMap(station) {
  const lat = Number(station.resolvedLat ?? station.lat), lon = Number(station.resolvedLon ?? station.lon);
  const title = `${station.name} — ${formatCoord(lat)}, ${formatCoord(lon)}`;
  if (mapMarker) map.removeLayer(mapMarker);
  mapMarker = L.marker([lat,lon]).addTo(map).bindPopup(`<strong>${escapeHtml(station.name)}</strong><br>${formatCoord(lat)}, ${formatCoord(lon)}`).openPopup();
  map.setView([lat,lon],13);
  $("#map-caption").textContent = title;
  const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
  $("#open-map").href = osm; $("#osm-link").href = osm;
  setTimeout(()=>map.invalidateSize(),80);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function renderAlternatives() {
  const container = $("#alternatives"); container.replaceChildren();
  currentCandidates.forEach((candidate,index)=>{
    const button=document.createElement("button"); button.type="button"; button.className="candidate"+(currentStation?.name===candidate.name?" active":"");
    const name=document.createElement("span"); name.className="candidate-name"; name.textContent=candidate.name;
    const meta=document.createElement("span"); meta.className="candidate-meta"; meta.textContent=`${candidate.massif} · ${candidate.distanceKm.toLocaleString("fr-FR",{maximumFractionDigits:1})} km du point saisi`;
    button.append(name,meta); button.addEventListener("click",()=>selectStation(candidate)); container.append(button);
  });
}
async function refineWithOpenStreetMap(station) {
  // Only query Nominatim when the catalogue coordinates are coarse (<5 decimal places).
  const decimals=Math.min(coordDecimals(station.lat),coordDecimals(station.lon));
  if(decimals>=5) return {lat:station.lat,lon:station.lon,source:"catalogue ALPÉLYS"};
  const cacheKey=normalize(station.name);
  if(geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  const url=new URL(NOMINATIM_URL);
  url.searchParams.set("format","jsonv2"); url.searchParams.set("limit","5"); url.searchParams.set("countrycodes","fr");
  url.searchParams.set("q",`${station.name}, France`);
  // Stay within the public Nominatim service's one-request-per-second guidance.
  const wait=Math.max(0,1150-(Date.now()-lastNominatimRequestAt));
  if(wait) await new Promise(resolve=>setTimeout(resolve,wait));
  lastNominatimRequestAt=Date.now();
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),7000);
  try {
    const response=await fetch(url,{signal:controller.signal,headers:{"Accept":"application/json"}});
    if(!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    const data=await response.json();
    const candidates=data.map(item=>({...item,lat:Number(item.lat),lon:Number(item.lon),distance:haversineKm(station.lat,station.lon,Number(item.lat),Number(item.lon))}))
      .filter(item=>Number.isFinite(item.lat)&&Number.isFinite(item.lon)&&item.distance<=20)
      .sort((a,b)=>a.distance-b.distance);
    if(candidates.length) {
      const result={lat:candidates[0].lat,lon:candidates[0].lon,source:"OpenStreetMap (Nominatim)",label:candidates[0].display_name};
      geocodeCache.set(cacheKey,result);
      return result;
    }
  } catch(error) {
    console.warn("Affinage OpenStreetMap indisponible :",error);
  } finally { clearTimeout(timeout); }
  const fallback={lat:station.lat,lon:station.lon,source:"catalogue ALPÉLYS (repli)"};
  geocodeCache.set(cacheKey,fallback);
  return fallback;
}
async function selectStation(station) {
  currentStation=station;
  $("#result-section").hidden=false;
  $("#station-massif").textContent=station.massif;
  $("#station-name").textContent=station.name;
  $("#station-distance").textContent=`Station la plus proche à ${station.distanceKm.toLocaleString("fr-FR",{maximumFractionDigits:1})} km du point saisi`;
  const conf=$("#confidence");
  conf.textContent=station.distanceKm<5?"Correspondance proche":station.distanceKm<15?"Correspondance probable":"À vérifier";
  conf.style.color=station.distanceKm<5?"var(--accent)":station.distanceKm<15?"var(--blue)":"var(--danger)";
  conf.style.borderColor=station.distanceKm<5?"#2a5e59":station.distanceKm<15?"#365a83":"#7f4549";
  conf.style.background=station.distanceKm<5?"#12332f":station.distanceKm<15?"#142a44":"#361e28";
  renderAlternatives();
  $("#precision-note").textContent="Recherche des coordonnées de référence…";
  $("#source-note").textContent="Les coordonnées retournées sont le point de référence utilisé pour représenter cette station.";
  $("#output-lat").textContent="…"; $("#output-lon").textContent="…";
  updateMap(station);
  const refinement=await refineWithOpenStreetMap(station);
  // Ignore slow results if the user selected another candidate meanwhile.
  if(currentStation!==station) return;
  station.resolvedLat=refinement.lat; station.resolvedLon=refinement.lon; station.source=refinement.source;
  $("#output-lat").textContent=formatCoord(refinement.lat); $("#output-lon").textContent=formatCoord(refinement.lon);
  $("#precision-note").textContent=refinement.source==="OpenStreetMap (Nominatim)"?"Coordonnées vérifiées via OpenStreetMap.":"Coordonnées de référence du catalogue affichées à 6 décimales.";
  $("#source-note").textContent=refinement.source==="OpenStreetMap (Nominatim)"?`Source : OpenStreetMap / Nominatim${refinement.label?` · ${refinement.label}`:""}. La position renvoyée est le point cartographique associé au nom de la station.`:"Source : catalogue ALPÉLYS. Les décimales ajoutées à l’affichage ne créent pas une précision supplémentaire dans la donnée source.";
  updateMap(station); renderAlternatives();
  setStatus(`Station reconnue : ${station.name}. Vérifie les autres suggestions si plusieurs stations sont proches.`, "success");
}
async function handleSearch(event) {
  event.preventDefault(); const button=$("#search-button"); button.disabled=true;
  try {
    const point=parseCoordinates($("#coordinate-input").value); validateCoordinates(point);
    setStatus("Recherche de la station la plus proche dans le catalogue…");
    const candidates=stationCandidates(point);
    if(!candidates.length) {
      $("#result-section").hidden=true;
      setStatus("Aucune station du catalogue n’a été trouvée dans un rayon de 45 km. Vérifie les coordonnées ou ajoute la station au catalogue.","error");
      map.setView([point.lat,point.lon],11); if(mapMarker)map.removeLayer(mapMarker);
      return;
    }
    currentCandidates=candidates;
    setStatus(`${candidates.length} station(s) candidate(s) trouvée(s). Vérification du point de référence…`);
    await selectStation(candidates[0]);
  } catch(error) { setStatus(error.message||"Une erreur est survenue.","error"); }
  finally { button.disabled=false; }
}
async function boot() {
  initMap();
  try {
    const response=await fetch(DATA_URL);
    if(!response.ok) throw new Error("stations.json inaccessible");
    stations=await response.json();
  } catch(error) {
    setStatus("Le catalogue de stations n’a pas pu être chargé. Vérifie que stations.json est bien publié à côté de index.html.","error");
    return;
  }
  $("#coordinate-form").addEventListener("submit",handleSearch);
  $("#use-example").addEventListener("click",()=>{$("#coordinate-input").value="lat: 45.889, lon: 6.735";$("#coordinate-form").requestSubmit();});
  $("#copy-coordinates").addEventListener("click",async()=>{
    if(!currentStation)return;
    const text=`lat: ${formatCoord(currentStation.resolvedLat??currentStation.lat)}, lon: ${formatCoord(currentStation.resolvedLon??currentStation.lon)}`;
    try { await navigator.clipboard.writeText(text); $("#copy-coordinates").textContent="Copié ✓"; setTimeout(()=>$("#copy-coordinates").textContent="Copier",1600); }
    catch { window.prompt("Copie ces coordonnées :",text); }
  });
  setTimeout(()=>$("#coordinate-form").requestSubmit(),180);
}
document.addEventListener("DOMContentLoaded",boot,{once:true});

// Agent de recherche des ressources d'une station (endpoint Cloudflare Pages Function).
const RESOURCE_AGENT_ENDPOINT = "./api/station-resources";
const resourceQueryUrl = (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

function resourceSearchesFor(station) {
  return [
    {label: "Rechercher le site officiel (hiver)", query: `"${station}" station ski site officiel hiver`},
    {label: "Rechercher les webcams", query: `"${station}" webcams domaine skiable station`},
    {label: "Rechercher le plan des pistes PDF récent", query: `"${station}" plan des pistes hiver 2026 2027 filetype:pdf`}
  ];
}

function validResourceUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !["localhost", "127.0.0.1"].includes(url.hostname);
  } catch { return false; }
}

function setResourceStatus(message, mode = "") {
  const status = document.querySelector("#resource-agent-status");
  status.textContent = message;
  status.className = `status ${mode}`.trim();
}

function showResourceLink(id, resource, fallbackMessage) {
  const link = document.getElementById(id);
  const detailsId = id.replace("-link", "-details");
  const details = document.getElementById(detailsId);
  const kind = document.getElementById(id.replace("-link", "-kind"));
  if (!resource || !validResourceUrl(resource.url)) {
    link.hidden = true;
    link.removeAttribute("href");
    details.textContent = fallbackMessage;
    if (kind) kind.textContent = "Aucun résultat suffisamment fiable";
    return;
  }
  link.href = resource.url;
  link.textContent = resource.title || resource.url;
  link.hidden = false;
  details.textContent = resource.snippet || "Aucun extrait descriptif fourni par le moteur de recherche.";
  if (kind) kind.textContent = resource.label || resource.status || "Résultat à vérifier";
}

function renderManualSearch(station, message) {
  const box = document.querySelector("#resource-manual-search");
  box.replaceChildren();
  const note = document.createElement("p");
  note.textContent = message;
  box.append(note);
  for (const item of resourceSearchesFor(station)) {
    const anchor = document.createElement("a");
    anchor.href = resourceQueryUrl(item.query);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = item.label;
    box.append(anchor);
  }
  box.hidden = false;
}

function renderResourceAlternatives(data) {
  const box = document.querySelector("#resource-alternatives");
  box.replaceChildren();
  const groups = [
    ["Autres sites officiels possibles", data.alternatives?.official],
    ["Autres pages de webcams", data.alternatives?.webcam],
    ["Autres plans PDF trouvés", data.alternatives?.plan]
  ];
  let hasAlternatives = false;
  for (const [label, resources] of groups) {
    if (!Array.isArray(resources) || resources.length === 0) continue;
    hasAlternatives = true;
    const heading = document.createElement("h4");
    heading.textContent = label;
    box.append(heading);
    for (const resource of resources.slice(0, 3)) {
      if (!validResourceUrl(resource.url)) continue;
      const row = document.createElement("div");
      row.className = "resource-alternative";
      const anchor = document.createElement("a");
      anchor.href = resource.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = resource.title || resource.url;
      row.append(anchor);
      const meta = document.createTextNode(` — ${resource.label || resource.snippet || "Résultat du moteur de recherche"}`);
      row.append(meta);
      box.append(row);
    }
  }
  box.hidden = !hasAlternatives;
}

function renderResourceAgent(data, station) {
  document.querySelector("#resource-agent-results").hidden = false;
  showResourceLink("official-link", data.official, "Recherche manuelle nécessaire : aucun résultat officiel suffisamment fiable n’a été identifié.");
  const officialKind = document.querySelector("#official-kind");
  if (data.official) officialKind.textContent = data.official.label || "Site officiel probable · version hiver privilégiée";

  showResourceLink("webcam-link", data.webcam, "Aucune page de webcams suffisamment pertinente n’a été identifiée.");
  document.querySelector("#webcam-scope").textContent = data.webcam?.scopeLabel || "Couverture non confirmée";
  if (data.webcam?.scopeReason) document.querySelector("#webcam-details").textContent = [data.webcam.snippet, data.webcam.scopeReason].filter(Boolean).join(" — ");

  showResourceLink("plan-link", data.plan, "Aucun lien direct vers un PDF n’a été identifié. Le lien vers les résultats permet de poursuivre la recherche.");
  document.querySelector("#plan-season").textContent = data.plan?.seasonLabel || (data.plan ? "PDF identifié — date à vérifier" : "Aucun PDF direct trouvé");
  if (data.plan?.snippet) document.querySelector("#plan-details").textContent = data.plan.snippet;

  const officialUrl = data.official?.url || "";
  const webcamUrl = data.webcam?.url || "";
  const planUrl = data.plan?.url || "";
  const webcamComment = data.webcam?.scopeLabel ? ` // ${data.webcam.scopeLabel}` : " // Couverture non confirmée";
  const planComment = data.plan?.seasonLabel ? ` // ${data.plan.seasonLabel}` : " // PDF récent non identifié";
  const output = `url: ${JSON.stringify(officialUrl)},\n\n            webcam: ${JSON.stringify(webcamUrl)},${webcamComment}\n\n            plan: ${JSON.stringify(planUrl)},${planComment}`;
  document.querySelector("#resource-code-output").textContent = output;
  renderResourceAlternatives(data);
  if (!data.official || !data.webcam || !data.plan) {
    renderManualSearch(station, "Au moins un lien n’a pas pu être confirmé automatiquement. Tu peux ouvrir directement les recherches correspondantes ci-dessous.");
  } else {
    document.querySelector("#resource-manual-search").hidden = true;
  }
}

async function handleResourceSearch(event) {
  event.preventDefault();
  const stationInput = document.querySelector("#resource-station-input");
  const button = document.querySelector("#resource-search-button");
  const station = stationInput.value.trim();
  if (station.length < 2) {
    setResourceStatus("Entre un nom de station suffisamment précis.", "error");
    return;
  }
  button.disabled = true;
  button.querySelector("span").textContent = "Recherche en cours…";
  document.querySelector("#resource-agent-results").hidden = true;
  document.querySelector("#resource-manual-search").hidden = true;
  setResourceStatus("Recherche du site officiel hiver, des webcams et du PDF le plus récent…");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    let response;
    try {
      response = await fetch(RESOURCE_AGENT_ENDPOINT, {
        method: "POST",
        headers: {"Content-Type": "application/json", "Accept": "application/json"},
        body: JSON.stringify({station}),
        signal: controller.signal
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      let errorMessage = `Le service de recherche répond HTTP ${response.status}.`;
      try { const err = await response.json(); if (err.error) errorMessage = err.error; } catch {}
      throw new Error(errorMessage);
    }
    const data = await response.json();
    renderResourceAgent(data, station);
    const found = [data.official, data.webcam, data.plan].filter(Boolean).length;
    setResourceStatus(`${found}/3 ressource(s) identifiée(s) pour ${station}. Vérifie les titres et la couverture avant d’utiliser les liens.`, found === 3 ? "success" : "");
  } catch (error) {
    document.querySelector("#resource-agent-results").hidden = true;
    renderManualSearch(station, `${error.name === "AbortError" ? "La recherche a dépassé le délai autorisé." : error.message || "Le service de recherche est indisponible."} L’agent automatique nécessite la fonction Cloudflare Pages fournie dans le dossier functions/. Si le site est hébergé uniquement sur GitHub Pages, les liens ci-dessous ouvrent des recherches manuelles.`);
    setResourceStatus("Recherche automatique indisponible : des recherches directes sont proposées ci-dessous.", "error");
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Rechercher les liens";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#resource-form");
  if (!form) return;
  form.addEventListener("submit", handleResourceSearch);
  document.querySelector("#resource-use-example").addEventListener("click", () => {
    document.querySelector("#resource-station-input").value = "Les 2 Alpes";
    form.requestSubmit();
  });
  document.querySelector("#copy-resource-code").addEventListener("click", async () => {
    const text = document.querySelector("#resource-code-output").textContent;
    const button = document.querySelector("#copy-resource-code");
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copié ✓";
      setTimeout(() => { button.textContent = "Copier le résultat"; }, 1500);
    } catch {
      window.prompt("Copie le résultat ci-dessous :", text);
    }
  });
});


// Convertisseur indépendant ajouté sans modifier le moteur de recherche des stations.
function parseHemisphereCoordinates(raw) {
  const matches = [...String(raw).matchAll(/([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([NSEW])/gi)];
  if (matches.length !== 2) {
    throw new Error('Format non reconnu. Exemple attendu : 45.892693°N 6.782763°E');
  }

  let lat = null;
  let lon = null;
  for (const match of matches) {
    const value = Math.abs(Number(match[1].replace(',', '.')));
    const hemisphere = match[2].toUpperCase();
    if (!Number.isFinite(value)) throw new Error('Une des coordonnées n’est pas un nombre valide.');
    if (hemisphere === 'N' || hemisphere === 'S') {
      if (lat !== null) throw new Error('Indique une seule latitude (N ou S) et une seule longitude (E ou W).');
      lat = hemisphere === 'S' ? -value : value;
    } else {
      if (lon !== null) throw new Error('Indique une seule latitude (N ou S) et une seule longitude (E ou W).');
      lon = hemisphere === 'W' ? -value : value;
    }
  }

  if (lat === null || lon === null) throw new Error('Il faut une latitude N/S et une longitude E/W.');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('Coordonnées hors limites : latitude entre −90° et 90°, longitude entre −180° et 180°.');
  }
  return { lat, lon };
}

function bootFormatConverter() {
  const form = document.querySelector('#format-converter-form');
  if (!form) return;
  const input = document.querySelector('#hemisphere-input');
  const status = document.querySelector('#format-status');
  const result = document.querySelector('#format-result');
  const output = document.querySelector('#formatted-coordinates');
  const convertButton = document.querySelector('#format-convert-button');
  const exampleButton = document.querySelector('#format-use-example');
  const copyButton = document.querySelector('#format-copy-button');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const point = parseHemisphereCoordinates(input.value);
      const indentation = ' '.repeat(13);
      output.textContent = `lat: ${point.lat.toFixed(6)},\n${indentation}lon: ${point.lon.toFixed(6)},`;
      result.hidden = false;
      status.textContent = 'Coordonnées converties. Le format avec indentation est prêt à copier.';
      status.className = 'status success';
    } catch (error) {
      result.hidden = true;
      status.textContent = error.message || 'Impossible de convertir ces coordonnées.';
      status.className = 'status error';
    }
  });

  exampleButton.addEventListener('click', () => {
    input.value = '45.892693°N 6.782763°E';
    form.requestSubmit();
  });

  copyButton.addEventListener('click', async () => {
    const text = output.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copié ✓';
      window.setTimeout(() => { copyButton.textContent = 'Copier'; }, 1600);
    } catch {
      window.prompt('Copie ce texte :', text);
    }
  });

  form.requestSubmit();
}

document.addEventListener('DOMContentLoaded', bootFormatConverter, { once: true });
