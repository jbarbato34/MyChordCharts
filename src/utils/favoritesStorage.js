import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

export async function loadFavorites(uid) {
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.exists() ? (snapshot.data().favorites || []) : [];
}

export async function saveFavorites(uid, songIds) {
  await setDoc(doc(db, 'users', uid), { favorites: songIds }, { merge: true });
}
