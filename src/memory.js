import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const categories = ['notes', 'progress'];

function read(path, max = 8000) {
  try {
    return readFileSync(path, 'utf8').slice(0, max);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

function write(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

function fileId(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function queueMemory(db, userId, key, category, content) {
  if (!content) return;
  db.prepare(`
    INSERT INTO memory_updates (key, user_id, category, content, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run(key, userId, category, content, Date.now());
}

export function loadMemory(db, dataDir, userId, assertLease, { apply = true } = {}) {
  const root = join(dataDir, 'memory', userId);
  if (apply) {
    db.transaction(() => {
      assertLease();
      for (const category of categories) mkdirSync(join(root, category), { recursive: true, mode: 0o700 });
      const updates = db.prepare(`
        SELECT * FROM memory_updates WHERE user_id = ? AND applied = 0 ORDER BY rowid
      `).all(userId);
      const reportPath = join(root, 'reported.md');
      for (const update of updates) {
        const id = fileId(update.key);
        if (update.category === 'reported') {
          const marker = `<!-- ${id} -->`;
          const existing = read(reportPath, 32000);
          if (!existing.includes(marker)) {
            write(reportPath, `${marker}\n${update.content.slice(0, 1200)}\n\n${existing}`.slice(0, 30000));
          }
        } else if (update.category === 'dreaming') {
          const seen = new Set();
          for (const category of categories) {
            for (const filename of readdirSync(join(root, category)).sort()) {
              if (!/^[a-f0-9]{64}\.md$/.test(filename)) continue;
              const path = join(root, category, filename);
              const content = read(path).trim().replace(/\s+/g, ' ');
              const signature = JSON.stringify([category, content]);
              if (!content || seen.has(signature)) unlinkSync(path);
              else seen.add(signature);
            }
          }
        } else {
          write(join(root, update.category, id + '.md'), update.content.slice(0, 1600));
        }
        db.prepare('UPDATE memory_updates SET applied = 1 WHERE key = ?').run(update.key);
      }
      rebuildIndex(db, root, userId);
    }).immediate();
  }
  const entries = db.prepare(`
    SELECT category, path, summary FROM mem_index WHERE user_id = ?
    ORDER BY updated_at DESC, path LIMIT 6
  `).all(userId);

  return {
    instructions: read(join(root, 'instructions.md'), 4000),
    index: read(join(root, 'index.md'), 2000),
    reported: read(join(root, 'reported.md'), 1800),
    entries: entries.map(entry => ({ ...entry, text: read(join(root, entry.path), 800) })),
  };
}

function rebuildIndex(db, root, userId) {
  const old = db.prepare('SELECT path, updated_at FROM mem_index WHERE user_id = ?').all(userId);
  const timestamps = new Map(old.map(row => [row.path, row.updated_at]));
  db.prepare('DELETE FROM mem_index WHERE user_id = ?').run(userId);
  const entries = [];
  for (const category of categories) {
    for (const file of readdirSync(join(root, category))) {
      if (!/^[a-f0-9]{64}\.md$/.test(file)) continue;
      const path = `${category}/${file}`;
      const summary = read(join(root, path), 160).replace(/\s+/g, ' ');
      const updatedAt = timestamps.get(path) ?? Date.now();
      entries.push({ path, summary, updatedAt });
      db.prepare('INSERT INTO mem_index VALUES (?, ?, ?, ?, ?)').run(userId, category, path, summary, updatedAt);
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
  write(join(root, 'index.md'), entries.map(entry => `- ${entry.path} ${entry.summary}`).join('\n').slice(0, 8000));
}

export function explicitFacts(events) {
  return events.filter(event => event.type === 'message').flatMap(event => {
    const match = JSON.parse(event.payload).text.match(/^(?:请?记住[：:\s]*|remember(?: that)?[ :]+)(.+)$/is);
    return match ? [match[1].trim()] : [];
  });
}
