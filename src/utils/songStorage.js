import { doc, getDoc, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';

const SONGS_DOC = doc(db, 'musician-app', 'songs');

// Sanitize before every write: Firestore rejects `undefined` field values outright,
// so stripping them here means one malformed song can't take down the whole document.
const sanitize = (songs) => JSON.parse(JSON.stringify({ songs }));

export async function saveSong(song) {
  // Read-modify-write on a transaction so a concurrent save/delete from another tab
  // or device can't silently undo this one (or vice versa) - a real risk since every
  // song lives in one shared document.
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(SONGS_DOC);
    const songs = snapshot.exists() ? (snapshot.data().songs || []) : [];
    const existingIndex = songs.findIndex((item) => item.id === song.id);

    if (existingIndex >= 0) {
      songs[existingIndex] = song;
    } else {
      songs.push(song);
    }

    transaction.set(SONGS_DOC, sanitize(songs));
  });
  return song;
}

export async function loadSongs() {
  const snapshot = await getDoc(SONGS_DOC);
  return snapshot.exists() ? (snapshot.data().songs || []) : [];
}

export async function deleteSong(id) {
  let remaining = [];
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(SONGS_DOC);
    const songs = snapshot.exists() ? (snapshot.data().songs || []) : [];
    remaining = songs.filter((song) => song.id !== id);
    transaction.set(SONGS_DOC, sanitize(remaining));
  });
  return remaining;
}

export async function clearAddedByFields() {
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(SONGS_DOC);
    if (!snapshot.exists()) return;
    const songs = (snapshot.data().songs || []).map((s) => ({ ...s, addedBy: '' }));
    transaction.set(SONGS_DOC, sanitize(songs));
  });
}

export function createSongDraft(title = '', artist = '', lyrics = '') {
  return {
    id: `song-${Date.now()}`,
    title,
    artist,
    lyrics,
    createdAt: new Date().toISOString(),
  };
}
