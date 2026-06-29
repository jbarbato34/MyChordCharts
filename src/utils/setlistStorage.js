import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

const SETLISTS_DOC = doc(db, 'musician-app', 'setlists');

export async function loadSetlists() {
  const snapshot = await getDoc(SETLISTS_DOC);
  return snapshot.exists() ? (snapshot.data().setlists || []) : [];
}

export async function saveSetlists(setlists) {
  // Firestore rejects `undefined` field values outright; stripping them here
  // means one malformed setlist can't take down the whole setlists document.
  await setDoc(SETLISTS_DOC, JSON.parse(JSON.stringify({ setlists })));
}
