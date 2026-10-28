import Globe from 'globe.gl';
import { AudioEngine } from './audio.js';
import { setupUploads } from './upload.js';
import './style.css';

const globeEl = document.getElementById('globe');
const intro = document.getElementById('intro');
const panel = document.getElementById('panel');

const recordings = await fetch('recordings.json').then((r) => r.json());
let audio = null;
let selectedId = null;

// Satellite tiles load progressively sharper as you zoom, down to street level.
const globe = new Globe(globeEl)
  .globeTileEngineUrl((x, y, l) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`)
  .globeTileEngineMaxLevel(19)
  .backgroundImageUrl('textures/night-sky.png')
  .pointsData(recordings)
  .pointLat('lat')
  .pointLng('lng')
  .pointAltitude(0.02)
  .pointRadius(0.9)
  .pointColor((d) => (d.id === selectedId ? '#ffd27a' : '#7ad7ff'))
  .pointLabel((d) => `<div class="tooltip">${escapeHtml(d.title)}</div>`)
  .onPointClick(select)
  .ringsData([])
  .ringColor(() => (t) => `rgba(255, 210, 122, ${1 - t})`)
  .ringMaxRadius(4)
  .ringPropagationSpeed(2)
  .ringRepeatPeriod(1200);

// Markers are sized for the whole-Earth view; shrink them as you zoom in so they stay usable up close.
let markerScale = 1;
globe.onZoom(({ altitude }) => {
  const scale = Math.min(1, altitude / 2.5);
  if (Math.abs(Math.log(scale / markerScale)) < 0.2) return; // skip tiny changes to avoid redrawing every frame
  markerScale = scale;
  globe.pointRadius(0.9 * scale).pointAltitude(0.02 * scale).ringMaxRadius(4 * scale);
});

window.addEventListener('resize', () => {
  globe.width(window.innerWidth).height(window.innerHeight);
});

// Browsers only allow audio after a user gesture, so the intro screen doubles as the unlock.
intro.addEventListener('click', async () => {
  audio = new AudioEngine();
  recordings.forEach((r) => audio.add(r));
  audio.onEnded = () => deselect();
  await audio.unlock();
  intro.classList.add('hidden');
});

// The form needs the upload inbox's address (VITE_UPLOAD_URL, set by the publish workflow or .env.local).
if (import.meta.env.VITE_UPLOAD_URL) setupUploads({ globe, uploadUrl: import.meta.env.VITE_UPLOAD_URL });

function select(rec) {
  if (selectedId === rec.id) return deselect();
  selectedId = rec.id;
  globe.pointOfView({ lat: rec.lat, lng: rec.lng, altitude: globe.pointOfView().altitude }, 1500); // keep the current zoom
  globe.ringsData([rec]);
  refreshPoints();
  showPanel(rec);
  audio?.play(rec.id);
}

function deselect() {
  if (selectedId) audio?.stop(selectedId);
  selectedId = null;
  globe.ringsData([]);
  refreshPoints();
  panel.classList.add('hidden');
}

function refreshPoints() {
  globe.pointColor(globe.pointColor()); // re-evaluate colours
}

function showPanel(rec) {
  panel.innerHTML = `
    <button class="close" aria-label="Stop">×</button>
    <h2>${escapeHtml(rec.title)}</h2>
    ${rec.author ? `<p class="author">by ${escapeHtml(rec.author)}</p>` : ''}
    <p class="meta">${escapeHtml(rec.date ?? '')}</p>
    <p>${escapeHtml(rec.notes ?? '')}</p>
  `;
  panel.querySelector('.close').addEventListener('click', deselect);
  panel.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
