// Inbox for recordings submitted from the site's "Add recording" form.
// The site is static, so uploads land here (in R2) and wait; the GitHub Action (.github/workflows/publish.yml)
// collects them with scripts/ingest.mjs, encodes them and republishes the site.
//
// R2 layout:   masters/<stamp>-<slug>.<ext>   original audio, kept permanently as the archive
//              pending/<stamp>-<slug>.json    details of a finished upload, deleted once it's published
//
// Every route needs "Authorization: Bearer <UPLOAD_PASSCODE>".

const AUDIO_EXTENSIONS = ['.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a'];

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (!(await authorised(request, env))) return json(401, { error: 'Wrong passcode.' });

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const key = url.searchParams.get('key') ?? '';

    try {
      // Uploads are multipart (start, parts, complete) because one Worker request is capped at 100 MB.
      if (route === 'POST /uploads') {
        const { meta, ext } = validate(await request.json());
        const masterKey = `masters/${stamp()}-${slugify(meta.title) || 'recording'}${ext}`;
        const upload = await env.BUCKET.createMultipartUpload(masterKey);
        return json(201, { key: masterKey, uploadId: upload.uploadId });
      }

      if (route === 'PUT /uploads/part') {
        if (!key.startsWith('masters/')) return json(400, { error: 'Bad key.' });
        const upload = env.BUCKET.resumeMultipartUpload(key, url.searchParams.get('uploadId'));
        const part = await upload.uploadPart(Number(url.searchParams.get('partNumber')), request.body);
        return json(200, part);
      }

      if (route === 'POST /uploads/complete') {
        const { key: masterKey, uploadId, parts, ...fields } = await request.json();
        if (!masterKey?.startsWith('masters/')) return json(400, { error: 'Bad key.' });
        const { meta } = validate(fields);
        await env.BUCKET.resumeMultipartUpload(masterKey, uploadId).complete(parts);
        const pendingKey = `pending/${masterKey.slice('masters/'.length).replace(/\.[^.]+$/, '')}.json`;
        await env.BUCKET.put(pendingKey, JSON.stringify({ ...meta, master: masterKey }));
        return json(201, { ok: true });
      }

      // Used by scripts/ingest.mjs.
      if (route === 'GET /pending') {
        const listed = await env.BUCKET.list({ prefix: 'pending/' });
        const items = await Promise.all(
          listed.objects.map(async (o) => ({ key: o.key, ...(await (await env.BUCKET.get(o.key)).json()) })),
        );
        return json(200, items);
      }

      if (route === 'GET /master') {
        const object = key.startsWith('masters/') && (await env.BUCKET.get(key));
        if (!object) return json(404, { error: 'Not found.' });
        return new Response(object.body, { headers: { ...cors, 'Content-Length': String(object.size) } });
      }

      if (route === 'DELETE /pending') {
        if (!key.startsWith('pending/')) return json(400, { error: 'Bad key.' });
        await env.BUCKET.delete(key);
        return json(200, { ok: true });
      }

      return json(404, { error: 'Not found.' });
    } catch (err) {
      return json(err instanceof InvalidInput ? 400 : 500, { error: err.message });
    }
  },
};

class InvalidInput extends Error {}

function validate({ filename, title, lat, lng, date, notes }) {
  const ext = /\.[^.]+$/.exec(String(filename ?? ''))?.[0].toLowerCase();
  title = String(title ?? '').trim();
  lat = Number(lat);
  lng = Number(lng);
  if (!AUDIO_EXTENSIONS.includes(ext)) throw new InvalidInput(`Unsupported file type. Use one of: ${AUDIO_EXTENSIONS.join(', ')}`);
  if (!title || title.length > 200) throw new InvalidInput('Give the recording a title (up to 200 characters).');
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) throw new InvalidInput('Latitude must be -90 to 90 and longitude -180 to 180.');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InvalidInput('Date must look like 2026-05-01.');
  if (notes && String(notes).length > 5000) throw new InvalidInput('Notes are limited to 5000 characters.');
  return { meta: { title, lat, lng, date: date || undefined, notes: notes ? String(notes).trim() : undefined }, ext };
}

// Hash both sides first so the comparison takes the same time whatever the passcode length.
async function authorised(request, env) {
  if (!env.UPLOAD_PASSCODE) return false;
  const given = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, env.UPLOAD_PASSCODE].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // 20261028T153000
}

function slugify(s) {
  return s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
