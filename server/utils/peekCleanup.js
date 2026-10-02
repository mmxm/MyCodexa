// Ephemeral "peek" books — a BookOrbit book fetched for a quick, read-only look without being
// permanently imported. Shared by the peek-creation route (server/routes/bookorbit.js), the
// explicit close-signal route, and the background sweep (server/routes/books.js, server/index.js).
//
// A peek row is a normal `books` row (so the existing reader/GET /:id and /:id/file routes work
// completely unchanged) flagged via `peek_expires_at` (non-null = ephemeral). Its file lives under
// PEEK_DIR instead of the permanent BOOKS_DIR, and both the row and the file are meant to be
// short-lived — cleaned up on graceful reader close, or (the actual guarantee, since a client
// signal can't be trusted after a forced close/crash) by sweepExpiredPeeks() on a timer.
const fs   = require('fs');
const path = require('path');
const { getDb, DATA_DIR } = require('../db');
const { removeCoverIfUnused } = require('./covers');

const PEEK_DIR         = path.join(DATA_DIR, 'tmp', 'peek');
const PEEK_TTL_SECONDS = 3 * 60 * 60; // 3h — generous since the file is fetched once per reader open, no heartbeat

function peekFilePath(userId, filename) {
  return path.join(PEEK_DIR, String(userId), filename);
}

// Mirrors the DELETE /api/books/:id precedent (server/routes/books.js) — unlink file, unlink
// cover if any, delete the row. Peek rows normally have no cover (see createBookOrbitPeek), but
// this stays defensive in case that ever changes.
function deletePeekRow(db, row) {
  try { fs.unlinkSync(peekFilePath(row.user_id, row.filename)); } catch { /* already gone */ }
  db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
  removeCoverIfUnused(db, row.cover_path);
}

// Two passes:
//  1. Expired rows (the normal case) — delete the row (cascades bookmarks/annotations/reading_
//     sessions/bookorbit_sync_state via ON DELETE CASCADE) + its file.
//  2. Orphaned files with no matching row — only possible if the server died between writing the
//     file and inserting the row; nothing else would ever find/clean these up otherwise.
function sweepExpiredPeeks() {
  const db  = getDb();
  const now = Math.floor(Date.now() / 1000);

  const expired = db.prepare(
    'SELECT id, user_id, filename, cover_path FROM books WHERE peek_expires_at IS NOT NULL AND peek_expires_at < ?'
  ).all(now);
  for (const row of expired) {
    try { deletePeekRow(db, row); } catch (e) { console.warn('[peek] cleanup failed for row', row.id, e.message); }
  }

  let orphanedFiles = 0;
  try {
    for (const userDir of fs.readdirSync(PEEK_DIR, { withFileTypes: true })) {
      if (!userDir.isDirectory()) continue;
      const userId  = Number(userDir.name);
      const dirPath = path.join(PEEK_DIR, userDir.name);
      const liveFilenames = new Set(
        db.prepare('SELECT filename FROM books WHERE user_id = ? AND peek_expires_at IS NOT NULL').all(userId).map(r => r.filename)
      );
      for (const filename of fs.readdirSync(dirPath)) {
        if (liveFilenames.has(filename)) continue;
        const filePath = path.join(dirPath, filename);
        try {
          const ageSeconds = now - Math.floor(fs.statSync(filePath).mtimeMs / 1000);
          if (ageSeconds > PEEK_TTL_SECONDS) { fs.unlinkSync(filePath); orphanedFiles++; }
        } catch { /* raced with something else removing it — ignore */ }
      }
    }
  } catch { /* PEEK_DIR missing — nothing to sweep */ }

  if (expired.length || orphanedFiles) {
    console.log(`[peek] swept ${expired.length} expired row(s), ${orphanedFiles} orphaned file(s)`);
  }
}

module.exports = { PEEK_DIR, PEEK_TTL_SECONDS, peekFilePath, deletePeekRow, sweepExpiredPeeks };
