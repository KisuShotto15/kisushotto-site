#!/usr/bin/env node
/**
 * Joplin → Notes App importer
 *
 * 1. En Joplin: Archivo > Exportar todo > MD - Markdown + Front Matter
 *    Esto genera una carpeta con .md por nota y _resources/ con imágenes.
 *
 * 2. Ejecutar:
 *    node scripts/joplin-import.js <carpeta-exportacion> <email>
 *
 *    Ejemplo:
 *    node scripts/joplin-import.js ~/Downloads/joplin-export efrenalejandro2010@gmail.com
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const WORKER_URL = 'https://notes-worker.efrenalejandro2010.workers.dev';
const TOKEN = '151322';
const BATCH_SIZE = 10;

// ── args ─────────────────────────────────────────────────────────────────────
const [exportDir, userEmail] = process.argv.slice(2);
if (!exportDir || !userEmail) {
  console.error('Uso: node scripts/joplin-import.js <carpeta-export> <email>');
  process.exit(1);
}
if (!fs.existsSync(exportDir)) {
  console.error(`No existe: ${exportDir}`);
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'X-User-Email': userEmail,
    ...extra,
  };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status} ${path}: ${txt}`);
  }
  return res.json();
}

// ── YAML frontmatter parser (minimal, covers Joplin's output) ────────────────
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      const [, k, v] = kv;
      meta[k] = v.trim().replace(/^["']|["']$/g, '');
    }
    // tags list
    const listTag = line.match(/^\s+-\s+(.+)$/);
    if (listTag && meta._lastKey === 'tags') {
      meta.tags = meta.tags || [];
      meta.tags.push(listTag[1].trim());
    }
    if (line.match(/^tags:/)) meta._lastKey = 'tags';
    else if (line.match(/^\w/)) meta._lastKey = null;
  }
  return { meta, body: match[2] };
}

// ── detect checklist ─────────────────────────────────────────────────────────
function parseChecklist(body) {
  const lines = body.split(/\r?\n/);
  const items = [];
  let isChecklist = true;
  let order = 0;

  for (const line of lines) {
    const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      items.push({ id: newUUID(), text: m[2].trim(), done: m[1].toLowerCase() === 'x', order: order++ });
    } else if (line.trim()) {
      isChecklist = false;
      break;
    }
  }
  if (items.length === 0) isChecklist = false;
  return isChecklist ? { type: 'checklist', checklist_items: items } : { type: 'text' };
}

function newUUID() {
  return crypto.randomUUID();
}

// Deterministic UUID from a string (for idempotent re-runs)
function stableId(str) {
  const h = createHash('md5').update(str).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

function parseDate(str) {
  if (!str) return Date.now();
  const d = new Date(str);
  return isNaN(d) ? Date.now() : d.getTime();
}

// ── upload attachment ─────────────────────────────────────────────────────────
async function uploadImage(filePath, noteId) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size > 10 * 1024 * 1024) {
    console.warn(`  ⚠ Imagen muy grande (${(stat.size / 1024 / 1024).toFixed(1)} MB), saltando: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  const mime = mimeMap[ext] || 'image/jpeg';

  const buf = fs.readFileSync(filePath);
  const res = await fetch(`${WORKER_URL}/attachments/upload?note_id=${noteId}&type=image`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': mime },
    body: buf,
  });
  if (!res.ok) {
    const txt = await res.text();
    console.warn(`  ⚠ Error subiendo ${path.basename(filePath)}: ${txt}`);
    return null;
  }
  const data = await res.json();
  return data.id;
}

// ── find resource file by Joplin resource ID ──────────────────────────────────
function findResourceFile(resourcesDir, resourceId) {
  if (!fs.existsSync(resourcesDir)) return null;
  const files = fs.readdirSync(resourcesDir);
  // Joplin resource IDs appear as filenames without extension or as <id>.<ext>
  const match = files.find(f => f.startsWith(resourceId));
  return match ? path.join(resourcesDir, match) : null;
}

// ── collect .md files recursively, skipping _resources ───────────────────────
function collectMdFiles(dir, base = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '_resources') {
      results.push(...collectMdFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // notebook = immediate subfolder name relative to base, or '' if root
      const rel = path.relative(base, dir);
      const notebook = rel || '';
      results.push({ file: full, notebook });
    }
  }
  return results;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nImportando desde: ${exportDir}`);
  console.log(`Usuario: ${userEmail}\n`);

  // Ensure user exists
  await apiFetch('/me');

  const resourcesDir = path.join(exportDir, '_resources');
  const mdEntries = collectMdFiles(exportDir);
  console.log(`Notas encontradas: ${mdEntries.length}`);

  // ── 1. Collect notebooks + tags → create categories ───────────────────────
  const tagMap = {}; // name → category id
  const allMeta = [];
  for (const { file, notebook } of mdEntries) {
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    allMeta.push({ file, notebook, meta, body });
    // notebook as category
    if (notebook && !tagMap[notebook]) tagMap[notebook] = newUUID();
    // YAML tags as categories too
    for (const tag of (meta.tags || [])) {
      if (!tagMap[tag]) tagMap[tag] = newUUID();
    }
  }

  const categories = Object.entries(tagMap).map(([name, id]) => ({
    id,
    owner_email: userEmail,
    name,
    color: '#fbbf24',
    created_at: Date.now(),
    updated_at: Date.now(),
  }));

  if (categories.length) {
    console.log(`Categorías a crear: ${categories.length} (${Object.keys(tagMap).join(', ')})`);
  }

  // ── 2. Build notes (without uploading images yet) ────────────────────────
  const notes = [];
  // noteImageMap: noteId → [resourceId, ...]
  const noteImageMap = new Map();

  for (let i = 0; i < allMeta.length; i++) {
    const { file, notebook, meta, body } = allMeta[i];
    const noteId = stableId(path.relative(exportDir, file));
    const title = meta.title || path.basename(file, '.md');
    const createdAt = parseDate(meta.created);
    const lastModified = Date.now() + i;

    process.stdout.write(`\r[${i + 1}/${allMeta.length}] ${title.slice(0, 50).padEnd(50)}`);

    const { type, checklist_items } = parseChecklist(body);

    // Collect image references (upload after notes exist in D1)
    const imageMatches = [
      ...[...body.matchAll(/!\[[^\]]*\]\(:\/([a-f0-9A-Za-z0-9_-]+)\)/g)].map(m => m[1]),
      ...[...body.matchAll(/!\[[^\]]*\]\([^)]*_resources\/([^)\s]+)\)/g)].map(m => m[1]),
      ...[...body.matchAll(/<img[^>]+src="[^"]*_resources\/([^"]+)"/g)].map(m => m[1]),
    ];
    const uniqueRefs = [...new Set(imageMatches)];
    if (uniqueRefs.length) noteImageMap.set(noteId, uniqueRefs);

    const cleanBody = type === 'text'
      ? body
          .replace(/!\[[^\]]*\]\(:\/[a-f0-9A-Za-z0-9_-]+\)/g, '')
          .replace(/!\[[^\]]*\]\([^)]*_resources\/[^\s)]+\)/g, '')
          .replace(/<img[^>]+src="[^"]*_resources\/[^"]+"[^>]*>/g, '')
          .trim()
      : body;

    notes.push({
      id: noteId,
      owner_email: userEmail,
      title,
      body: type === 'text' ? cleanBody : null,
      type,
      checklist_items: checklist_items || null,
      color: null,
      pinned: 0,
      archived: 0,
      trashed_at: null,
      locked: 0,
      reminder_at: null,
      reminder_sent: 0,
      last_modified: lastModified,
      created_at: createdAt,
      categories: [
        ...(notebook ? [tagMap[notebook]] : []),
        ...(meta.tags || []).map(t => tagMap[t]),
      ].filter(Boolean),
    });
  }

  // ── 3. Sync notes in batches ───────────────────────────────────────────────
  console.log(`\n\nSincronizando notas en lotes de ${BATCH_SIZE}...`);
  let synced = 0;

  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    const batch = notes.slice(i, i + BATCH_SIZE);
    await apiFetch('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: batch,
        categories: i === 0 ? categories : [],
      }),
    });
    synced += batch.length;
    process.stdout.write(`\r  ${synced}/${notes.length} notas sincronizadas`);
  }

  // ── 4. Upload images (notes now exist in D1) ───────────────────────────────
  let imgCount = 0;
  if (noteImageMap.size) {
    console.log(`\n\nSubiendo imágenes para ${noteImageMap.size} notas...`);
    let n = 0;
    for (const [noteId, refs] of noteImageMap) {
      n++;
      process.stdout.write(`\r  nota ${n}/${noteImageMap.size}`);
      for (const resourceId of refs) {
        const filePath = findResourceFile(resourcesDir, resourceId);
        if (filePath) {
          const attId = await uploadImage(filePath, noteId);
          if (attId) imgCount++;
        }
      }
    }
  }

  console.log(`\n\n✓ Importación completa.`);
  console.log(`  ${notes.length} notas | ${categories.length} categorías | ${imgCount} imágenes`);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
