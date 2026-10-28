import Globe from 'globe.gl';
import { AudioEngine } from './audio.js';
import { setupUploads } from './upload.js';
import './style.css';

const globeEl = document.getElementById('globe');
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

// Browsers only allow audio after a user gesture, so the engine is created on the first pin click.
function ensureAudio() {
  if (!audio) {
    audio = new AudioEngine();
    recordings.forEach((r) => audio.add(r));
    audio.onEnded = () => deselect();
  }
  audio.unlock();
  return audio;
}

// The form needs the upload inbox's address (VITE_UPLOAD_URL, set by the publish workflow or .env.local).
if (import.meta.env.VITE_UPLOAD_URL) setupUploads({ globe, uploadUrl: import.meta.env.VITE_UPLOAD_URL });

function select(rec) {
  if (selectedId === rec.id) return deselect();
  selectedId = rec.id;
  globe.pointOfView({ lat: rec.lat, lng: rec.lng, altitude: globe.pointOfView().altitude }, 1500); // keep the current zoom
  globe.ringsData([rec]);
  refreshPoints();
  showPanel(rec);
  ensureAudio().play(rec.id);
  updatePlayButton();
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
    <header>
      <button class="play"></button>
      <h2>${escapeHtml(rec.title)}</h2>
    </header>
    ${rec.author ? `<p class="author">by ${escapeHtml(rec.author)}</p>` : ''}
    <p class="meta">${escapeHtml(rec.date ?? '')}</p>
    <p>${escapeHtml(rec.notes ?? '')}</p>
  `;
  panel.querySelector('.close').addEventListener('click', deselect);
  panel.querySelector('.play').addEventListener('click', togglePlayback);
  updatePlayButton();
  panel.classList.remove('hidden');
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

function togglePlayback() {
  if (!selectedId) return;
  if (audio?.isPlaying(selectedId)) audio.pause(selectedId);
  else ensureAudio().play(selectedId);
  updatePlayButton();
}

function updatePlayButton() {
  const button = panel.querySelector('.play');
  if (!button) return;
  const playing = audio?.isPlaying(selectedId);
  button.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

// Space bar toggles play/pause while a recording is open (but not while typing in the upload form).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !selectedId || e.target.closest('input, textarea, button')) return;
  e.preventDefault();
  togglePlayback();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
