// Collects recordings submitted through the site's form from the Cloudflare inbox (worker/), encodes them
// with encode.sh and adds them to public/recordings.json. Run by .github/workflows/publish.yml.
// Needs UPLOAD_URL (the worker's address) and UPLOAD_PASSCODE in the environment.
//
// Usage: node scripts/ingest.mjs --count   print how many submissions are waiting (0 if the inbox isn't set up)
//        node scripts/ingest.mjs           add waiting submissions to the site
//        node scripts/ingest.mjs --ack     clear submissions from the inbox once they're in recordings.json;
//                                          run after the commit is pushed, so nothing is lost if the push fails

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const listPath = path.join(root, 'public/recordings.json');
const { UPLOAD_URL, UPLOAD_PASSCODE } = process.env;
const mode = process.argv[2];

if (!UPLOAD_URL || !UPLOAD_PASSCODE) {
  if (mode === '--count') {
    console.log(0);
    process.exit(0);
  }
  throw new Error('Set UPLOAD_URL and UPLOAD_PASSCODE.');
}

const api = async (route, init) => {
  const res = await fetch(new URL(route, UPLOAD_URL), { ...init, headers: { Authorization: `Bearer ${UPLOAD_PASSCODE}` } });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${route}: ${res.status} ${await res.text()}`);
  return res;
};

const pending = await (await api('pending')).json();
const recordings = JSON.parse(await readFile(listPath, 'utf8'));
const published = new Set(recordings.map((r) => r.master).filter(Boolean));

if (mode === '--count') {
  console.log(pending.length);
} else if (mode === '--ack') {
  for (const item of pending.filter((p) => published.has(p.master))) {
    await api(`pending?key=${encodeURIComponent(item.key)}`, { method: 'DELETE' });
    console.log(`cleared ${item.key}`);
  }
} else {
  await mkdir(path.join(root, 'originals'), { recursive: true });
  // Skip anything already published whose --ack didn't run, so a recording never appears twice.
  for (const item of pending.filter((p) => !published.has(p.master))) {
    const id = uniqueId(slugify(item.title) || 'recording', recordings);
    const original = `originals/${id}${path.extname(item.master)}`;
    const res = await api(`master?key=${encodeURIComponent(item.master)}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(path.join(root, original)));
    execFileSync(path.join(root, 'scripts/encode.sh'), [original], { cwd: root, stdio: 'inherit' });

    const { title, author, lat, lng, date, notes, master } = item;
    recordings.push({ id, title, author, lat, lng, date, file: `audio/${id}.mp3`, notes, master });
    console.log(`added ${id} from ${master}`);
  }
  await writeFile(listPath, JSON.stringify(recordings, null, 2) + '\n');
}

// Matches the name encode.sh gives the MP3 (lowercase, dashes), so the id and MP3 share one name.
function slugify(s) {
  return s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueId(base, recordings) {
  const taken = (id) => recordings.some((r) => r.id === id) || existsSync(path.join(root, 'public/audio', `${id}.mp3`));
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}
