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
