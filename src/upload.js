// "Add recording" form. Submissions go to the Cloudflare inbox (worker/), not straight onto the site:
// the publish workflow collects them, encodes them and rebuilds, so a new pin appears after the next run.

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // the Worker enforces the same limit (worker/src/index.js)
const PART_SIZE = 25 * 1024 * 1024; // R2 needs equal parts of at least 5 MB; one Worker request allows up to 100 MB
const PASSCODE_KEY = 'upload-passcode';
const AUTHOR_KEY = 'upload-author';

export function setupUploads({ globe, uploadUrl }) {
  const button = document.createElement('button');
  button.id = 'add-btn';
  button.textContent = '+ Add recording';
  document.body.append(button);

  const form = document.createElement('form');
  form.id = 'upload';
  form.className = 'hidden';
  form.innerHTML = `
    <h2>Add a recording</h2>
    <label>Audio file (max 10 MB) <input name="file" type="file" accept=".wav,.aif,.aiff,.flac,.mp3,.m4a" required></label>
    <label>Title <input name="title" required maxlength="200"></label>
    <label>Author <input name="author" maxlength="200" autocomplete="name"></label>
    <div class="row">
      <label>Latitude <input name="lat" type="number" step="any" min="-90" max="90" required placeholder="51.4769"></label>
      <label>Longitude <input name="lng" type="number" step="any" min="-180" max="180" required placeholder="-0.0005"></label>
    </div>
    <p class="hint">Click the globe to set the location, paste "lat, lng" from Google Maps into Latitude, or
      <button type="button" class="link" data-action="locate">use my current location</button>.</p>
    <label>Date <input name="date" type="date"></label>
    <label>Notes <textarea name="notes" rows="3" maxlength="5000"></textarea></label>
    <label>Passcode <input name="passcode" type="password" required autocomplete="current-password"></label>
    <p class="status" aria-live="polite"></p>
    <div class="actions">
      <button type="button" data-action="cancel">Close</button>
      <button type="submit">Submit</button>
    </div>
  `;
  document.body.append(form);

  const field = (name) => form.elements.namedItem(name);
  const status = form.querySelector('.status');
  const marker = document.createElement('div');
  marker.className = 'upload-marker';

  try {
    field('passcode').value = localStorage.getItem(PASSCODE_KEY) ?? '';
    field('author').value = localStorage.getItem(AUTHOR_KEY) ?? '';
  } catch {}

  const open = () => {
    form.classList.remove('hidden');
    button.classList.add('hidden');
  };
  const close = () => {
    form.classList.add('hidden');
    button.classList.remove('hidden');
    globe.htmlElementsData([]);
  };

  const setLocation = (lat, lng) => {
    field('lat').value = +lat.toFixed(6);
    field('lng').value = +lng.toFixed(6);
    showMarker();
  };
  const showMarker = () => {
    const lat = parseFloat(field('lat').value);
    const lng = parseFloat(field('lng').value);
    globe.htmlElementsData(Number.isFinite(lat) && Number.isFinite(lng) ? [{ lat, lng }] : []);
  };

  globe.htmlElement(() => marker).htmlAltitude(0);
  globe.onGlobeClick(({ lat, lng }) => {
    if (!form.classList.contains('hidden')) setLocation(lat, lng);
  });

  button.addEventListener('click', open);
  form.querySelector('[data-action="cancel"]').addEventListener('click', close);

  form.querySelector('[data-action="locate"]').addEventListener('click', () => {
    status.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        status.textContent = '';
        setLocation(pos.coords.latitude, pos.coords.longitude);
        globe.pointOfView({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 1500);
      },
      (err) => (status.textContent = `Couldn't get your location: ${err.message}`),
    );
  });

  // Google Maps copies coordinates as "51.4769, -0.0005"; accept that pasted into either box.
  for (const name of ['lat', 'lng']) {
    field(name).addEventListener('paste', (e) => {
      const m = e.clipboardData.getData('text').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (!m) return;
      e.preventDefault();
      setLocation(Number(m[1]), Number(m[2]));
    });
    field(name).addEventListener('input', showMarker);
  }

  // Prefill title and date from the file: "Morning_Chorus.wav" -> "Morning Chorus", date from when it was last modified.
  field('file').addEventListener('change', () => {
    const file = field('file').files[0];
    if (!file) return;
    status.textContent = file.size > MAX_UPLOAD_BYTES ? tooBig(file) : '';
    if (!field('title').value) field('title').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    if (!field('date').value) {
      const d = new Date(file.lastModified);
      field('date').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = field('file').files[0];
    if (file.size > MAX_UPLOAD_BYTES) return (status.textContent = tooBig(file));
    const passcode = field('passcode').value;
    const details = { filename: file.name };
    for (const name of ['title', 'author', 'lat', 'lng', 'date', 'notes']) details[name] = field(name).value;

    const call = async (route, init) => {
      const res = await fetch(new URL(route, uploadUrl), {
        ...init,
        headers: { Authorization: `Bearer ${passcode}`, ...init.headers },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status}).`);
      return body;
    };
    const sendJson = (route, data) =>
      call(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    status.textContent = 'Starting upload…';
    try {
      const { key, uploadId } = await sendJson('uploads', details);
      try {
        localStorage.setItem(PASSCODE_KEY, passcode); // accepted, so remember it (and the author) on this device
        localStorage.setItem(AUTHOR_KEY, details.author);
      } catch {}

      const parts = [];
      const count = Math.max(1, Math.ceil(file.size / PART_SIZE));
      for (let i = 0; i < count; i++) {
        status.textContent = `Uploading… ${Math.round((i / count) * 100)}%`;
        const query = new URLSearchParams({ key, uploadId, partNumber: i + 1 });
        const chunk = file.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
        parts.push(await call(`uploads/part?${query}`, { method: 'PUT', body: chunk }));
      }
      await sendJson('uploads/complete', { ...details, key, uploadId, parts });

      form.reset();
      field('passcode').value = passcode;
      field('author').value = details.author;
      globe.htmlElementsData([]);
      status.textContent = `Sent “${details.title}”. It will appear on the globe after the next rebuild (usually within the hour).`;
    } catch (err) {
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
}

function tooBig(file) {
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
  return `That file is ${mb(file.size)} MB; the limit is ${mb(MAX_UPLOAD_BYTES)} MB. Try exporting it as MP3 or M4A.`;
}
