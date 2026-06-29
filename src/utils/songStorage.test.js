import { createSongDraft, loadSongs, saveSong, deleteSong } from './songStorage';

describe('song storage', () => {
  it('saves and loads songs from firestore', async () => {
    const song = createSongDraft('Your Song', 'Elton John', 'Hello');
    await saveSong(song);

    expect(await loadSongs()).toEqual([song]);
  });

  it('removes a song from firestore', async () => {
    const song = createSongDraft('Your Song', 'Elton John', 'Hello');
    await saveSong(song);
    await deleteSong(song.id);

    expect(await loadSongs()).toEqual([]);
  });
});
