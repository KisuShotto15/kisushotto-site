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
import { createReadStream, statSync } from 'fs';

const WORKER_URL = 'https://notes-worker.efrenalejandro2010.workers.dev';
const TOKEN = '151322';
const BATCH_SIZE = 50;

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

function parseDate(str) {
  if (!str) return Date.now();
  const d = new Date(str);
  return isNaN(d) ? Date.now() : d.getTime();
}

// ── upload attachment ─────────────────────────────────────────────────────────
async function uploadImage(filePath, noteId) {
  if (!fs.existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (stat.size > 10 * 1024 * 1024) {
    console.warn(`  ⚠ Imagen muy grande (${(stat.size / 1024 / 1024).toFixed(1)} MB), saltando: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  const mime = mimeMap[ext] || 'image/jpeg';

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)], { type: mime });
  form.append('file', blob, path.basename(filePath));
  form.append('note_id', noteId);

  const res = await fetch(`${WORKER_URL}/attachments/upload`, {
    method: 'POST',
    headers: headers(),
    body: form,
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

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nImportando desde: ${exportDir}`);
  console.log(`Usuario: ${userEmail}\n`);

  // Ensure user exists
  await apiFetch('/me');

  const resourcesDir = path.join(exportDir, '_resources');
  const mdFiles = fs.readdirSync(exportDir).filter(f => f.endsWith('.md'));
  console.log(`Notas encontradas: ${mdFiles.length}`);

  // ── 1. Collect all tags → create categories ────────────────────────────────
  const tagMap = {}; // tag name → category id
  const allMeta = [];
  for (const file of mdFiles) {
    const raw = fs.readFileSync(path.join(exportDir, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    allMeta.push({ file, meta, body });
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

  // ── 2. Build notes + upload images ─────────────────────────────────────────
  const notes = [];
  let imgCount = 0;

  for (let i = 0; i < allMeta.length; i++) {
    const { file, meta, body } = allMeta[i];
    const noteId = newUUID();
    const title = meta.title || path.basename(file, '.md');
    const createdAt = parseDate(meta.created);
    const lastModified = parseDate(meta.updated || meta.created);

    process.stdout.write(`\r[${i + 1}/${allMeta.length}] ${title.slice(0, 50).padEnd(50)}`);

    // Detect checklist
    const { type, checklist_items } = parseChecklist(body);

    // Find image references: ![alt](:/resourceId) or ![alt](./_resources/file)
    const imageRefs = [...body.matchAll(/!\[([^\]]*)\]\(:\/([a-f0-9]+)\)/g)];
    const attachmentIds = [];

    for (const [, , resourceId] of imageRefs) {
      const filePath = findResourceFile(resourcesDir, resourceId);
      if (filePath) {
        const attId = await uploadImage(filePath, noteId);
        if (attId) { attachmentIds.push(attId); imgCount++; }
      }
    }

    // Strip image refs from body (they'll show as card thumbnails)
    const cleanBody = type === 'text'
      ? body.replace(/!\[[^\]]*\]\(:\/[a-f0-9]+\)/g, '').trim()
      : body;

    notes.push({
      id: noteId,
      owner_email: userEmail,
      title,
      body: type === 'text' ? cleanBody : null,
      type,
      checklist_items: checklist_items ? JSON.stringify(checklist_items) : null,
      color: null,
      pinned: 0,
      archived: 0,
      trashed_at: null,
      locked: 0,
      reminder_at: null,
      reminder_sent: 0,
      last_modified: lastModified,
      created_at: createdAt,
      categories: (meta.tags || []).map(t => tagMap[t]).filter(Boolean),
    });
  }

  console.log(`\n\nImágenes subidas: ${imgCount}`);

  // ── 3. Sync in batches ─────────────────────────────────────────────────────
  console.log(`\nSincronizando notas en lotes de ${BATCH_SIZE}...`);
  let synced = 0;

  // Send categories once with first batch
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

  console.log(`\n\n✓ Importación completa.`);
  console.log(`  ${notes.length} notas | ${categories.length} categorías | ${imgCount} imágenes`);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
