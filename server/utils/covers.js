// Cover files live in one flat folder shared by every user, named after the book's content hash
// (see extractEpubMetadata / extractCbzMetadata / the PDF cover upload). So two users — or one user
// twice, after a re-import — who own the same file point at the SAME cover file. Deleting one book
// must not delete a cover another book still uses. Confirmed live: deleting one user's copy of a
// book removed the shared cover and left another family member's copy with a broken cover image.
const fs   = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db');

const COVERS_DIR = path.join(DATA_DIR, 'covers');

// Deletes the cover file only if no book row (other than excludeBookId, if given) still points at
// it. Call AFTER deleting the book row(s) being removed, or pass the still-present row's id as
// excludeBookId. Returns true if the file was removed.
function removeCoverIfUnused(db, coverPath, excludeBookId = null) {
  if (!coverPath) return false;
  const stillUsed = excludeBookId == null
    ? db.prepare('SELECT 1 FROM books WHERE cover_path = ? LIMIT 1').get(coverPath)
    : db.prepare('SELECT 1 FROM books WHERE cover_path = ? AND id != ? LIMIT 1').get(coverPath, excludeBookId);
  if (stillUsed) return false;
  try { fs.unlinkSync(path.join(COVERS_DIR, coverPath)); return true; } catch { return false; }
}

module.exports = { removeCoverIfUnused, COVERS_DIR };
