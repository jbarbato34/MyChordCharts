import React, { useState, useEffect, useRef } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { GoogleAuthProvider, signInWithCredential, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { createSongDraft, deleteSong, loadSongs, saveSong } from './utils/songStorage';
import { loadFavorites, saveFavorites } from './utils/favoritesStorage';
import { loadSetlists, saveSetlists } from './utils/setlistStorage';

let nextBlockId = 0;
function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  nextBlockId += 1;
  return `block-${Date.now()}-${nextBlockId}`;
}

// Aligns the existing blocks against a freshly-edited lyrics text via an LCS line diff,
// so unchanged lines keep their id (and therefore their chords/sections) while only
// truly added or removed lines gain a fresh id or drop out.
function reconcileBlocksWithLyrics(existingBlocks, lyricsText) {
  const newLines = lyricsText.split('\n');
  const oldTexts = existingBlocks.map((block) => block.text);
  const m = oldTexts.length;
  const n = newLines.length;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldTexts[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result = [];
  let i = 0;
  let j = 0;
  while (j < n) {
    if (i < m && oldTexts[i] === newLines[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      result.push(existingBlocks[i]);
      i++;
      j++;
    } else if (i < m && dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      result.push({ id: newId(), text: newLines[j] });
      j++;
    }
  }
  return result;
}

// Renders section labels as "[LABEL]" lines directly above their lyric line, so the
// Edit Lyrics textarea can show and edit them inline.
function decorateLyricsWithTags(blocks, sections) {
  const lines = [];
  blocks.forEach((block) => {
    const label = sections[block.id];
    if (label) {
      lines.push(`[${label.toUpperCase()}]`);
    }
    lines.push(block.text);
  });
  return lines.join('\n');
}

// Inverse of decorateLyricsWithTags: strips "[LABEL]" marker lines back out, returning
// the plain lyrics text plus which (post-strip) line index each label belongs to.
function undecorateLyrics(text) {
  const rawLines = text.split('\n');
  const lyricsLines = [];
  const tagsByLineIndex = {};
  let pendingTag = null;

  rawLines.forEach((line) => {
    const match = line.trim().match(/^\[(.+)\]$/);
    if (match) {
      pendingTag = match[1].trim();
      return;
    }
    if (pendingTag !== null) {
      tagsByLineIndex[lyricsLines.length] = pendingTag;
      pendingTag = null;
    }
    lyricsLines.push(line);
  });

  return { plainLyrics: lyricsLines.join('\n'), tagsByLineIndex };
}


// Splits a line into words WITHOUT dropping empty entries, so a chord with no word
// under it (anywhere in the line, not just trailing) is a real, addressable word slot
// rather than something that has to be tracked in a separate data structure.
function getWords(text) {
  return text === '' ? [] : text.split(' ');
}

// The word/chord list for display: grows to cover the highest chorded index even if no
// word was ever typed there, and always keeps exactly one fully-empty trailing slot so
// there's always somewhere to add the next chord and/or word.
function getDisplayWords(words, blockId, chords) {
  let maxIndex = words.length - 1;
  Object.keys(chords).forEach((key) => {
    const prefix = `${blockId}-`;
    if (key.startsWith(prefix) && chords[key]) {
      const idx = Number(key.slice(prefix.length));
      if (idx > maxIndex) maxIndex = idx;
    }
  });

  const result = [];
  for (let i = 0; i <= maxIndex; i++) {
    result.push(words[i] || '');
  }
  const lastWord = result[result.length - 1];
  const lastChord = chords[`${blockId}-${result.length - 1}`];
  if (result.length === 0 || lastWord !== '' || lastChord) {
    result.push('');
  }
  return result;
}

function buildSectionsFromTags(blocks, tagsByLineIndex) {
  const sections = {};
  blocks.forEach((block, index) => {
    if (tagsByLineIndex[index] !== undefined) {
      sections[block.id] = tagsByLineIndex[index];
    }
  });
  return sections;
}

// Groups consecutive blocks under one section label (chords editor only) so the
// bordered box spans every line in that section, not just the line right after the
// label. A blank/instrumental line always closes the current group, since it reads
// as a visual break; a new label always opens a fresh group.
function groupBlocksIntoSections(blocks, sections) {
  const groups = [];
  let current = null;

  for (const block of blocks) {
    const label = sections[block.id]; // undefined = not a section start; any string = section starts here

    if (label !== undefined) {
      current = { label, blocks: [block] };
      groups.push(current);
    } else if (current) {
      current.blocks.push(block);
    } else {
      const last = groups[groups.length - 1];
      if (last && last.label === null) {
        last.blocks.push(block);
      } else {
        groups.push({ label: null, blocks: [block] });
      }
    }
  }

  return groups;
}

const CHORD_COLOR = '#6699cc';

const CHORD_INPUT_STYLE = {
  position: 'absolute', top: '-15px', left: 0,
  color: CHORD_COLOR, fontWeight: '600', border: 'none', borderBottom: '1px solid #ddd',
  background: 'transparent', fontSize: '13px', width: '56px',
  outline: 'none', fontFamily: 'inherit', padding: '1px 0', cursor: 'text', lineHeight: 1,
};

const SECTION_INPUT_STYLE = {
  fontSize: '12px', color: '#999', border: 'none', borderBottom: '1px dashed #ccc',
  background: 'transparent', outline: 'none', fontFamily: 'inherit', padding: '2px 4px', width: '100px',
};

const WORD_INPUT_STYLE = {
  border: 'none', background: 'transparent', fontSize: '16px',
  outline: 'none', fontFamily: 'inherit', padding: 0, color: 'inherit',
};

// For chord-only rows (instrumental blocks): same visual as CHORD_INPUT_STYLE but
// NOT position:absolute — inputs live in normal flex flow so they're actually visible.
const CHORD_SLOT_INPUT_STYLE = {
  color: CHORD_COLOR, fontWeight: '600', border: 'none', borderBottom: '1px solid #ddd',
  background: 'transparent', fontSize: '13px', width: '56px',
  outline: 'none', fontFamily: 'inherit', padding: '1px 0', cursor: 'text', lineHeight: 1,
};

// Shift+Enter jumps straight to the next line's first field instead of tabbing through
// every remaining "+" on the current line (e.g. the add-more-chords button).
function focusNextLineOnShiftEnter(e) {
  if (!(e.shiftKey && e.key === 'Enter')) return;
  e.preventDefault();
  const currentBlockId = e.currentTarget.getAttribute('data-block-id');
  const all = Array.from(document.querySelectorAll('[data-block-id]'));
  const startIndex = all.indexOf(e.currentTarget);
  for (let i = startIndex + 1; i < all.length; i++) {
    if (all[i].getAttribute('data-block-id') !== currentBlockId) {
      all[i].focus();
      return;
    }
  }
}

// ArrowDown on a chord field jumps to its word field, and ArrowUp does the reverse -
// Tab is reserved for moving chord-to-chord (or word-to-word) instead of alternating.
function focusCounterpartOnVerticalArrow(e, dataKey) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const el = document.querySelector(`[data-key="${dataKey}"]`);
  if (!el) return;
  e.preventDefault();
  el.focus();
}

// Word fields are excluded from the normal tab order (so chord-to-chord tabbing skips
// them), but that means Tab pressed *from* a word field would otherwise jump out to
// whatever chord field comes next in document order. Intercept it so Tab/Shift+Tab
// from a word field stays within words.
function focusAdjacentWordOnTab(e) {
  if (e.key !== 'Tab') return;
  const all = Array.from(document.querySelectorAll('[data-key^="word-"]'));
  const idx = all.indexOf(e.currentTarget);
  if (idx === -1) return;
  const target = all[e.shiftKey ? idx - 1 : idx + 1];
  if (!target) return;
  e.preventDefault();
  target.focus();
}

// Always renders one extra empty slot past the real ones, so there's always a blue "+"
// ready to type into. Typing into it commits it as a real slot (and a new empty one
// appears after). Backspace in an empty slot removes the slot before it - the trailing
// blank slot itself is never removed, since backspace there removes its predecessor, not itself.
function ChordSlotRow({ blockId, slots, onChange, onRemove, onEnter, onDeleteLine }) {
  const displaySlots = [...slots, ''];

  return (
    <>
      {displaySlots.map((chord, slotIndex) => (
        <input
          key={slotIndex}
          data-key={`${blockId}-extra-${slotIndex}`}
          data-block-id={blockId}
          value={chord}
          onChange={(e) => onChange(slotIndex, e.target.value)}
          onKeyDown={(e) => {
            focusNextLineOnShiftEnter(e);
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter?.();
              return;
            }
            if (e.key === 'Backspace' && chord === '' && slotIndex === 0 && slots.every(s => !s)) {
              e.preventDefault();
              onDeleteLine?.();
              return;
            }
            if (e.key === 'Backspace' && chord === '' && slotIndex > 0) {
              e.preventDefault();
              onRemove(slotIndex - 1);
            }
          }}
          placeholder="+"
          style={CHORD_SLOT_INPUT_STYLE}
        />
      ))}
    </>
  );
}

function InsertBar({ onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: hover ? '18px' : '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        color: hover ? '#666' : 'transparent',
        fontSize: '11px',
        transition: 'all 0.15s'
      }}
    >
      {hover ? '+ Insert line here' : ''}
    </div>
  );
}

function SectionToggleStrip({ isSectionStart, onToggle }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={isSectionStart ? 'Remove section start' : 'Start section here'}
      style={{
        width: '22px',
        flexShrink: 0,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '2px',
        userSelect: 'none',
      }}
    >
      <span style={{
        fontSize: '11px',
        color: isSectionStart ? '#888' : hover ? '#aaa' : '#ddd',
        transition: 'color 0.12s',
        lineHeight: 1,
      }}>
        {isSectionStart ? '▶' : '▷'}
      </span>
    </div>
  );
}

const formatDate = (date) => `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

function App() {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [keySignature, setKeySignature] = useState('');
  const [bpm, setBpm] = useState('');
  const [length, setLength] = useState('');
  const [step, setStep] = useState('home');
  const [user, setUser] = useState(null);
  const [favorites, setFavorites] = useState([]);
  const [browseFilter, setBrowseFilter] = useState('all');
  const [signInPrompt, setSignInPrompt] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setUser({ name: firebaseUser.displayName, email: firebaseUser.email, picture: firebaseUser.photoURL, uid: firebaseUser.uid });
        Promise.all([loadSongs(), loadSetlists(), loadFavorites(firebaseUser.uid)])
          .then(([loadedSongs, loadedSetlists, loadedFavorites]) => {
            setSavedSongs(loadedSongs);
            setFavorites(loadedFavorites);
            const syncedSetlists = syncSetlistsWithSavedSongs(loadedSongs, loadedSetlists);
            persistSetlists(syncedSetlists);
            setIsLoaded(true);
          })
          .catch(() => {
            setLoadError(true);
            setIsLoaded(true);
          });
      } else {
        setUser(null);
        setSavedSongs([]);
        setIsLoaded(true);
      }
    });
    return unsubscribe;
  }, []);
  const [blocks, setBlocks] = useState([]);
  const [chords, setChords] = useState({});
  const [sections, setSections] = useState({});
  const [instrumentalChords, setInstrumentalChords] = useState({});
  const [savedSongs, setSavedSongs] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSongId, setActiveSongId] = useState(null);
  const [isEditingSong, setIsEditingSong] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [sortKey, setSortKey] = useState('title');
  const [sortDirection, setSortDirection] = useState('asc');
  const [setlists, setSetlists] = useState([]);
  const [activeSetlistId, setActiveSetlistId] = useState(null);
  const [selectedSongIds, setSelectedSongIds] = useState([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editingSectionBlockId, setEditingSectionBlockId] = useState(null);
  const [pendingRemoveSetlistSong, setPendingRemoveSetlistSong] = useState(null);
  const lyricsDecoratedRef = useRef(false);
  const pendingFocusKeyRef = useRef(null);
  const historyRef = useRef([]);
  const typingSessionRef = useRef(false);
  const typingTimerRef = useRef(null);

  useEffect(() => {
    if (pendingFocusKeyRef.current) {
      const el = document.querySelector(`[data-key="${pendingFocusKeyRef.current}"]`);
      if (el) {
        el.focus();
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, 0);
      }
      pendingFocusKeyRef.current = null;
    }
  });

  const markDirty = () => setHasUnsavedChanges(true);
  const markSaved = () => setHasUnsavedChanges(false);

  const captureHistory = () => {
    historyRef.current = [
      ...historyRef.current.slice(-49),
      {
        blocks: blocks.map(b => ({ ...b })),
        chords: { ...chords },
        sections: { ...sections },
        instrumentalChords: Object.fromEntries(
          Object.entries(instrumentalChords).map(([k, v]) => [k, [...(v || [])]])
        ),
      },
    ];
  };

  const captureHistoryBeforeTyping = () => {
    if (!typingSessionRef.current) {
      captureHistory();
      typingSessionRef.current = true;
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      typingSessionRef.current = false;
      typingTimerRef.current = null;
    }, 800);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey && step === 'chords') {
        if (historyRef.current.length === 0) return;
        e.preventDefault();
        const prev = historyRef.current[historyRef.current.length - 1];
        historyRef.current = historyRef.current.slice(0, -1);
        setBlocks(prev.blocks);
        setChords(prev.chords);
        setSections(prev.sections);
        setInstrumentalChords(prev.instrumentalChords);
        setHasUnsavedChanges(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // The single point where blocks are kept honest against the lyrics textarea: reconciles
  // blocks/lyrics via an LCS line diff, and - only when the textarea was showing [TAG] section
  // markers (i.e. we're leaving the Edit Lyrics page) - rebuilds section labels from those
  // markers so a deleted/edited tag line actually changes the section assignment.
  const syncLyricsAndBlocks = () => {
    if (lyricsDecoratedRef.current) {
      lyricsDecoratedRef.current = false;
      const { plainLyrics, tagsByLineIndex } = undecorateLyrics(lyrics);
      const reconciledBlocks = reconcileBlocksWithLyrics(blocks, plainLyrics);
      const survivingIds = new Set(reconciledBlocks.map((block) => block.id));
      return {
        lyrics: plainLyrics,
        blocks: reconciledBlocks,
        sections: buildSectionsFromTags(reconciledBlocks, tagsByLineIndex),
        instrumentalChords: Object.fromEntries(
          Object.entries(instrumentalChords).filter(([blockId]) => survivingIds.has(blockId))
        ),
        chords: Object.fromEntries(
          Object.entries(chords).filter(([key]) => survivingIds.has(key.slice(0, key.lastIndexOf('-'))))
        ),
      };
    }

    const reconciledBlocks = reconcileBlocksWithLyrics(blocks, lyrics);
    const survivingIds = new Set(reconciledBlocks.map((block) => block.id));
    return {
      lyrics,
      blocks: reconciledBlocks,
      sections: Object.fromEntries(Object.entries(sections).filter(([blockId]) => survivingIds.has(blockId))),
      instrumentalChords: Object.fromEntries(
        Object.entries(instrumentalChords).filter(([blockId]) => survivingIds.has(blockId))
      ),
      chords: Object.fromEntries(
        Object.entries(chords).filter(([key]) => survivingIds.has(key.slice(0, key.lastIndexOf('-'))))
      ),
    };
  };
  const syncSetlistsWithSavedSongs = (songs, currentSetlists = setlists) => {
    const songsById = new Map(songs.map((song) => [song.id, song]));

    return currentSetlists.map((list) => ({
      ...list,
      songs: (list.songs || []).map((song) => {
        const latest = song && song.songId ? songsById.get(song.songId) : (song && song.id ? songsById.get(song.id) : null);
        if (latest) {
          return { ...song, ...latest, id: song.id || latest.id, songId: song.songId || latest.id };
        }
        return song;
      }),
    }));
  };
  const persistSetlists = (nextSetlists) => {
    setSetlists(nextSetlists);
    saveSetlists(nextSetlists).catch(() => {
      window.alert('Could not save setlists to the database. Check your connection and try again.');
    });
  };

  const confirmBeforeLeaving = (nextStep) => {
    if (!hasUnsavedChanges) {
      setIsEditingSong(false);
      setStep(nextStep);
      return;
    }

    const shouldSave = window.confirm('You have unsaved changes. Save before leaving?');
    if (shouldSave) {
      saveEditedSong();
    }
    setIsEditingSong(false);
    setStep(nextStep);
  };

  const goHome = () => confirmBeforeLeaving('home');

  const toggleFavorite = (songId) => {
    const next = favorites.includes(songId)
      ? favorites.filter((id) => id !== songId)
      : [...favorites, songId];
    setFavorites(next);
    if (user?.uid) {
      saveFavorites(user.uid, next).catch(() => console.error('Failed to save favorites'));
    }
  };


  const resetSongDraft = () => {
    setTitle('');
    setArtist('');
    setLyrics('');
    setKeySignature('');
    setBpm('');
    setLength('');
    setBlocks([]);
    setChords({});
    setSections({});
    setInstrumentalChords({});
    setActiveSongId(null);
    setIsEditingSong(false);
    setHasUnsavedChanges(false);
  };

  const startNewSong = () => {
    resetSongDraft();
    lyricsDecoratedRef.current = true;
    setStep('input');
  };

  const parseLengthToSeconds = (value) => {
    if (!value) return 0;
    const [minutes, seconds] = value.split(':').map(Number);
    if (Number.isNaN(minutes) || Number.isNaN(seconds)) return 0;
    return minutes * 60 + seconds;
  };

  const formatLengthFromSeconds = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const getSetlistTotalTime = (songs) => {
    const totalSeconds = songs.reduce((sum, song) => sum + parseLengthToSeconds(song.length), 0);
    return formatLengthFromSeconds(totalSeconds);
  };

  const toggleSongSelection = (songId) => {
    setSelectedSongIds((prev) => (prev.includes(songId) ? prev.filter((id) => id !== songId) : [...prev, songId]));
  };

  const addSelectedSongsToSetlist = () => {
    if (selectedSongIds.length === 0) return;

    const selectedSongs = savedSongs.filter((song) => selectedSongIds.includes(song.id)).map((song) => ({
      id: song.id,
      songId: song.id,
      title: song.title || '',
      artist: song.artist || '',
      keySignature: song.keySignature || '',
      bpm: song.bpm || '',
      length: song.length || '',
      lyrics: song.lyrics || '',
      blocks: song.blocks || [],
      chords: song.chords || {},
      sections: song.sections || {},
      instrumentalChords: song.instrumentalChords || {},
    }));

    const existingSetlistNames = setlists.map((list) => list.name);
    const choice = window.prompt(
      existingSetlistNames.length > 0
        ? `Choose an existing setlist name or type a new name:\n${existingSetlistNames.join(', ')}`
        : 'Type a name for your new setlist:',
      activeSetlistId ? (setlists.find((list) => list.id === activeSetlistId)?.name || '') : ''
    );
    if (choice === null) return;

    const trimmedName = choice.trim();
    if (!trimmedName) return;

    let nextSetlists = [...setlists];
    let targetSetlist = nextSetlists.find((list) => list.name.toLowerCase() === trimmedName.toLowerCase());
    if (!targetSetlist) {
      targetSetlist = {
        id: `setlist-${Date.now()}`,
        name: trimmedName,
        songs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      nextSetlists = [...nextSetlists, targetSetlist];
    }

    nextSetlists = nextSetlists.map((list) => list.id === targetSetlist.id
      ? { ...list, songs: [...(list.songs || []), ...selectedSongs], updatedAt: new Date().toISOString() }
      : list);
    persistSetlists(nextSetlists);
    setSelectedSongIds([]);
    setActiveSetlistId(targetSetlist.id);

    const shouldOpenSetlist = window.confirm('Add more songs and stay on the songs page? Cancel keeps you browsing, OK opens the setlist.');
    setStep(shouldOpenSetlist ? 'setlists' : 'browse');
  };

  const createSetlist = (name) => {
    const trimmedName = (name || '').trim();
    if (!trimmedName) return null;

    const newSetlist = {
      id: `setlist-${Date.now()}`,
      name: trimmedName,
      songs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    persistSetlists([...setlists, newSetlist]);
    setActiveSetlistId(newSetlist.id);
    return newSetlist;
  };

  const updateSetlist = (setlistId, updater) => {
    persistSetlists(setlists.map((list) => (list.id === setlistId ? { ...updater(list), updatedAt: new Date().toISOString() } : list)));
  };

  const moveSetlistSong = (setlistId, index, direction) => {
    const targetSetlist = setlists.find((list) => list.id === setlistId);
    if (!targetSetlist) return;

    const songs = [...(targetSetlist.songs || [])];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= songs.length) return;

    [songs[index], songs[swapIndex]] = [songs[swapIndex], songs[index]];
    updateSetlist(setlistId, (list) => ({ ...list, songs }));
  };

  const renameSetlist = (setlistId) => {
    const targetSetlist = setlists.find((list) => list.id === setlistId);
    if (!targetSetlist) return;

    const choice = window.prompt('Rename this setlist:', targetSetlist.name);
    if (choice === null) return;

    const trimmedName = choice.trim();
    if (!trimmedName) return;

    updateSetlist(setlistId, (list) => ({ ...list, name: trimmedName }));
  };

  const removeSetlistSong = (setlistId, index) => {
    const targetSetlist = setlists.find((list) => list.id === setlistId);
    if (!targetSetlist) return;

    const songs = [...(targetSetlist.songs || [])];
    songs.splice(index, 1);
    updateSetlist(setlistId, (list) => ({ ...list, songs }));
  };

  const isValidLength = (value) => {
    if (!value) return true;
    return /^\d{1,2}:\d{2}$/.test(value);
  };

  const saveCurrentSong = (options = {}) => {
    if (!isValidLength(length)) {
      window.alert('Length must be in m:ss format, for example 3:12.');
      return;
    }

    const synced = syncLyricsAndBlocks();
    const existingSong = savedSongs.find((song) => song.id === activeSongId);
    const draft = {
      id: activeSongId || `song-${Date.now()}`,
      title,
      artist,
      lyrics: synced.lyrics,
      keySignature,
      bpm,
      length,
      createdAt: existingSong?.createdAt || new Date().toISOString(),
      addedBy: existingSong ? (existingSong.addedBy || '') : (user?.name || ''),
      addedAt: existingSong ? (existingSong.addedAt || '') : formatDate(new Date()),
      updatedAt: new Date().toISOString(),
      updatedBy: user?.name || '',
      chords: synced.chords,
      sections: synced.sections,
      instrumentalChords: synced.instrumentalChords,
      blocks: synced.blocks,
    };
    setLyrics(synced.lyrics);
    setBlocks(synced.blocks);
    setSections(synced.sections);
    setChords(synced.chords);
    setInstrumentalChords(synced.instrumentalChords);
    const existingIndex = savedSongs.findIndex((song) => song.id === draft.id);
    const nextSavedSongs = existingIndex >= 0
      ? savedSongs.map((song) => (song.id === draft.id ? draft : song))
      : [...savedSongs, draft];
    setSavedSongs(nextSavedSongs);
    persistSetlists(syncSetlistsWithSavedSongs(nextSavedSongs, setlists));
    saveSong(draft)
      .then(() => { markSaved(); })
      .catch((err) => {
        console.error('Firestore save failed:', err);
        window.alert('Could not save this song to the database. Check your connection and try again.');
      });

    if (options.stayOnPreview) {
      setActiveSongId(draft.id);
      setIsEditingSong(false);
      setStep('preview');
      return;
    }

    setTitle('');
    setArtist('');
    setLyrics('');
    setBlocks([]);
    setChords({});
    setSections({});
    setInstrumentalChords({});
    setActiveSongId(null);
    setIsEditingSong(false);
    setStep('browse');
  };

  const openSongForPreview = (song) => {
    lyricsDecoratedRef.current = false;
    setActiveSongId(song.id);
    setTitle(song.title || '');
    setArtist(song.artist || '');
    setLyrics(song.lyrics || '');
    setKeySignature(song.keySignature || '');
    setBpm(song.bpm || '');
    setLength(song.length || '');

    const loadedBlocks = Array.isArray(song.blocks) && song.blocks.length > 0
      ? song.blocks
      : song.lyrics ? song.lyrics.split('\n').map((line) => ({ id: newId(), text: line })) : [];

    // Migrate any instrumentalChords stored on lyric blocks (text !== '') — these were
    // orphaned by old data or a conversion path that didn't clean up. Without this,
    // the preview shows them as extra chord slots while the editor shows nothing.
    const loadedIC = { ...(song.instrumentalChords || {}) };
    const loadedChords = { ...(song.chords || {}) };
    loadedBlocks.forEach((block) => {
      if (block.text.trim() !== '' && loadedIC[block.id]) {
        (loadedIC[block.id] || []).forEach((slot, i) => {
          if (slot && !loadedChords[`${block.id}-${i}`]) {
            loadedChords[`${block.id}-${i}`] = slot;
          }
        });
        delete loadedIC[block.id];
      }
    });

    setBlocks(loadedBlocks);
    setChords(loadedChords);
    setSections(song.sections || {});
    setInstrumentalChords(loadedIC);
    setHasUnsavedChanges(false);
    setIsEditingSong(false);
    setStep('preview');
  };

  const goToEditor = () => {
    if (!hasUnsavedChanges) {
      setIsEditingSong(true);
      setStep('chords');
      return;
    }

    const shouldSave = window.confirm('You have unsaved changes. Save before leaving?');
    if (shouldSave) {
      saveEditedSong();
    }
    setIsEditingSong(true);
    setStep('chords');
  };

  const goToPreview = () => {
    if (!hasUnsavedChanges) {
      setIsEditingSong(false);
      setStep('preview');
      return;
    }

    const shouldSave = window.confirm('You have unsaved changes. Save before leaving?');
    if (shouldSave) {
      saveEditedSong();
    }
    setIsEditingSong(false);
    setStep('preview');
  };

  const goToLyrics = () => {
    if (!hasUnsavedChanges) {
      setLyrics(decorateLyricsWithTags(blocks, sections));
      lyricsDecoratedRef.current = true;
      setIsEditingSong(false);
      setStep('input');
      return;
    }

    const shouldSave = window.confirm('You have unsaved changes. Save before leaving?');
    if (shouldSave) {
      saveEditedSong();
    }
    setLyrics(decorateLyricsWithTags(blocks, sections));
    lyricsDecoratedRef.current = true;
    setIsEditingSong(false);
    setStep('input');
  };

  const saveEditedSong = () => {
    if (!isValidLength(length)) {
      window.alert('Length must be in m:ss format, for example 3:12.');
      return;
    }

    const draftId = activeSongId || `song-${Date.now()}`;
    const synced = syncLyricsAndBlocks();
    const existingSong = savedSongs.find((song) => song.id === activeSongId);
    const draft = {
      id: draftId,
      title,
      artist,
      lyrics: synced.lyrics,
      keySignature,
      bpm,
      length,
      createdAt: existingSong?.createdAt || new Date().toISOString(),
      addedBy: existingSong ? (existingSong.addedBy || '') : (user?.name || ''),
      addedAt: existingSong ? (existingSong.addedAt || '') : formatDate(new Date()),
      updatedAt: new Date().toISOString(),
      updatedBy: user?.name || '',
      chords: synced.chords,
      sections: synced.sections,
      instrumentalChords: synced.instrumentalChords,
      blocks: synced.blocks,
    };
    setActiveSongId(draftId);
    setLyrics(synced.lyrics);
    setBlocks(synced.blocks);
    setSections(synced.sections);
    setChords(synced.chords);
    setInstrumentalChords(synced.instrumentalChords);
    const existingIndex = savedSongs.findIndex((song) => song.id === draftId);
    const nextSavedSongs = existingIndex >= 0
      ? savedSongs.map((song) => (song.id === draftId ? draft : song))
      : [...savedSongs, draft];
    setSavedSongs(nextSavedSongs);
    persistSetlists(syncSetlistsWithSavedSongs(nextSavedSongs, setlists));
    saveSong(draft)
      .then(() => { markSaved(); })
      .catch((err) => {
        console.error('Firestore save failed:', err);
        window.alert('Could not save this song to the database. Check your connection and try again.');
      });
  };

  const startChords = () => {
    const synced = syncLyricsAndBlocks();
    const migratedIC = { ...synced.instrumentalChords };
    const migratedChords = { ...synced.chords };
    synced.blocks.forEach((block) => {
      if (block.text.trim() !== '' && migratedIC[block.id]) {
        (migratedIC[block.id] || []).forEach((slot, i) => {
          if (slot && !migratedChords[`${block.id}-${i}`]) {
            migratedChords[`${block.id}-${i}`] = slot;
          }
        });
        delete migratedIC[block.id];
      }
    });
    setLyrics(synced.lyrics);
    setBlocks(synced.blocks);
    setSections(synced.sections);
    setChords(migratedChords);
    setInstrumentalChords(migratedIC);
    setStep('chords');
  };

  const updateChordValue = (blockId, wordIndex, value) => {
    captureHistoryBeforeTyping();
    const key = `${blockId}-${wordIndex}`;
    setChords({ ...chords, [key]: value });
    markDirty();
  };

  const removeSection = (blockId) => {
    captureHistory();
    const updated = { ...sections };
    delete updated[blockId];
    setSections(updated);
    markDirty();
  };

  const convertInstrumentalToLyric = (blockId, text, blockIndex) => {
    captureHistory();
    // Remap existing chord slots onto word-chord positions so they don't disappear
    const existingSlots = instrumentalChords[blockId] || [];
    if (existingSlots.length > 0) {
      const updatedChords = { ...chords };
      existingSlots.forEach((slotChord, i) => {
        if (slotChord) updatedChords[`${blockId}-${i}`] = slotChord;
      });
      setChords(updatedChords);
    }
    setBlocks(blocks.map(b => b.id === blockId ? { ...b, text } : b));
    const lines = lyrics.split('\n');
    lines[blockIndex] = text;
    setLyrics(lines.join('\n'));
    const updatedIC = { ...instrumentalChords };
    delete updatedIC[blockId];
    setInstrumentalChords(updatedIC);
    markDirty();
    pendingFocusKeyRef.current = `word-${blockId}-0`;
  };

  const toggleSectionAt = (blockId) => {
    if (sections[blockId] !== undefined) {
      removeSection(blockId);
    } else {
      captureHistory();
      setSections({ ...sections, [blockId]: '' });
      setEditingSectionBlockId(blockId);
      pendingFocusKeyRef.current = `section-${blockId}`;
      markDirty();
    }
  };

  const updateInstrumentalChordValue = (blockId, slotIndex, value) => {
    captureHistoryBeforeTyping();
    const current = instrumentalChords[blockId] || [];
    const updated = [...current];
    updated[slotIndex] = value;
    setInstrumentalChords({ ...instrumentalChords, [blockId]: updated });
    markDirty();
  };

  const removeInstrumentalSlot = (blockId, slotIndex) => {
    captureHistory();
    const current = instrumentalChords[blockId] || [];
    setInstrumentalChords({ ...instrumentalChords, [blockId]: current.filter((_, i) => i !== slotIndex) });
    pendingFocusKeyRef.current = `${blockId}-extra-${slotIndex}`;
    markDirty();
  };

  const insertEmptyLineAt = (index) => {
    captureHistory();
    const id = newId();
    const updatedBlocks = [...blocks];
    updatedBlocks.splice(index, 0, { id, text: '' });
    setBlocks(updatedBlocks);
    const lines = lyrics.split('\n');
    lines.splice(index, 0, '');
    setLyrics(lines.join('\n'));
    markDirty();
    pendingFocusKeyRef.current = `${id}-extra-0`;
  };

  const deleteEmptyBlock = (blockId, currentGlobalIndex) => {
    captureHistory();
    const updatedBlocks = blocks.filter((b) => b.id !== blockId);
    setBlocks(updatedBlocks);
    const lines = lyrics.split('\n');
    lines.splice(currentGlobalIndex, 1);
    setLyrics(lines.join('\n'));
    const updatedInstrumental = { ...instrumentalChords };
    delete updatedInstrumental[blockId];
    setInstrumentalChords(updatedInstrumental);
    const updatedSections = { ...sections };
    delete updatedSections[blockId];
    setSections(updatedSections);
    // focus the block above
    if (currentGlobalIndex > 0) {
      const prevBlock = blocks[currentGlobalIndex - 1];
      if (prevBlock) {
        const prevSlots = instrumentalChords[prevBlock.id] || [];
        const prevIsInstrumental = prevBlock.text.trim() === '';
        pendingFocusKeyRef.current = prevIsInstrumental
          ? `${prevBlock.id}-extra-${prevSlots.length}`
          : `${prevBlock.id}-${Math.max(0, getWords(prevBlock.text).length - 1)}`;
      }
    }
    markDirty();
  };

  const insertSectionAt = (index) => {
    const id = newId();
    const updatedBlocks = [...blocks];
    updatedBlocks.splice(index, 0, { id, text: '' });
    setBlocks(updatedBlocks);

    const lines = lyrics.split('\n');
    lines.splice(index, 0, '');
    setLyrics(lines.join('\n'));

    markDirty();
    setEditingSectionBlockId(id);
    pendingFocusKeyRef.current = `section-${id}`;
  };

  // Merges a line into the end of the line before it, shifting its chords' word
  // indices onto the previous block instead of dropping them. Skipped if the line
  // being merged away has its own section label, since that would silently erase
  // a section boundary.
  const mergeBlockIntoPrevious = (currentGlobalIndex) => {
    if (currentGlobalIndex <= 0) return;
    captureHistory();
    const prevBlock = blocks[currentGlobalIndex - 1];
    const curBlock = blocks[currentGlobalIndex];
    if (sections[curBlock.id]) return;

    const wordOffset = getWords(prevBlock.text).length;
    const mergedText = `${prevBlock.text} ${curBlock.text}`.trim();

    const nextChords = { ...chords };
    Object.keys(chords).forEach((key) => {
      const prefix = `${curBlock.id}-`;
      if (key.startsWith(prefix)) {
        const wordIndex = Number(key.slice(prefix.length));
        nextChords[`${prevBlock.id}-${wordOffset + wordIndex}`] = chords[key];
        delete nextChords[key];
      }
    });

    const nextInstrumentalChords = { ...instrumentalChords };
    const mergedSlots = [...(instrumentalChords[prevBlock.id] || []), ...(instrumentalChords[curBlock.id] || [])];
    if (mergedSlots.length > 0) {
      nextInstrumentalChords[prevBlock.id] = mergedSlots;
    }
    delete nextInstrumentalChords[curBlock.id];

    const nextBlocks = blocks
      .map((b) => (b.id === prevBlock.id ? { ...b, text: mergedText } : b))
      .filter((b) => b.id !== curBlock.id);

    const lines = lyrics.split('\n');
    lines.splice(currentGlobalIndex - 1, 2, mergedText);
    setLyrics(lines.join('\n'));

    setBlocks(nextBlocks);
    setChords(nextChords);
    setInstrumentalChords(nextInstrumentalChords);
    pendingFocusKeyRef.current = `${prevBlock.id}-${wordOffset}`;
    markDirty();
  };

  // Word-processor-style Enter: splits the line at the given word, pushing that word
  // and everything after it onto a brand-new line, with their chords following along.
  const splitBlockAtWord = (currentGlobalIndex, wordIndex) => {
    captureHistory();
    const block = blocks[currentGlobalIndex];
    const words = getWords(block.text);
    const textBefore = words.slice(0, wordIndex).join(' ');
    const textAfter = words.slice(wordIndex).join(' ');
    const newBlockId = newId();

    const nextChords = { ...chords };
    Object.keys(chords).forEach((key) => {
      const prefix = `${block.id}-`;
      if (key.startsWith(prefix)) {
        const idx = Number(key.slice(prefix.length));
        if (idx >= wordIndex) {
          nextChords[`${newBlockId}-${idx - wordIndex}`] = chords[key];
          delete nextChords[key];
        }
      }
    });

    const nextInstrumentalChords = { ...instrumentalChords };
    if (instrumentalChords[block.id]) {
      nextInstrumentalChords[newBlockId] = instrumentalChords[block.id];
      delete nextInstrumentalChords[block.id];
    }

    const nextBlocks = [...blocks];
    nextBlocks[currentGlobalIndex] = { ...block, text: textBefore };
    nextBlocks.splice(currentGlobalIndex + 1, 0, { id: newBlockId, text: textAfter });
    setBlocks(nextBlocks);

    const lines = lyrics.split('\n');
    lines.splice(currentGlobalIndex, 1, textBefore, textAfter);
    setLyrics(lines.join('\n'));

    setChords(nextChords);
    setInstrumentalChords(nextInstrumentalChords);
    pendingFocusKeyRef.current = `${newBlockId}-0`;
    markDirty();
  };

  const updateWordText = (blockId, wordIndex, newText) => {
    captureHistoryBeforeTyping();
    const block = blocks.find((b) => b.id === blockId);
    const words = getWords(block.text);
    words[wordIndex] = newText;
    const newBlockText = words.join(' ');
    setBlocks(blocks.map((b) => (b.id === blockId ? { ...b, text: newBlockText } : b)));

    const globalIndex = blocks.findIndex((b) => b.id === blockId);
    const lines = lyrics.split('\n');
    lines[globalIndex] = newBlockText;
    setLyrics(lines.join('\n'));
    markDirty();
  };

  // Space pressed on a chord field (rather than a word field): inserts a fresh empty
  // word at this position, shifting this chord and every later one up by one index,
  // so adding a word feels the same whether you're focused on the chord or the word.
  const insertWordAt = (blockId, wordIndex) => {
    captureHistory();
    const block = blocks.find((b) => b.id === blockId);
    const words = getWords(block.text);
    const newWords = [...words];
    newWords.splice(wordIndex, 0, '');
    const newText = newWords.join(' ');

    const nextChords = {};
    Object.keys(chords).forEach((key) => {
      const prefix = `${blockId}-`;
      if (!key.startsWith(prefix)) {
        nextChords[key] = chords[key];
        return;
      }
      const idx = Number(key.slice(prefix.length));
      nextChords[idx >= wordIndex ? `${blockId}-${idx + 1}` : key] = chords[key];
    });

    setChords(nextChords);
    setBlocks(blocks.map((b) => (b.id === blockId ? { ...b, text: newText } : b)));

    const globalIndex = blocks.findIndex((b) => b.id === blockId);
    const lines = lyrics.split('\n');
    lines[globalIndex] = newText;
    setLyrics(lines.join('\n'));

    pendingFocusKeyRef.current = `word-${blockId}-${wordIndex}`;
    markDirty();
  };

  // Word-processor-style Space: splits the word at the cursor into two words, shifting
  // every later word's chord up by one index. Splitting at the very end of the last
  // word (cursor with nothing after it) effectively appends a fresh empty word.
  const splitWordAt = (blockId, wordIndex, cursorPos) => {
    const block = blocks.find((b) => b.id === blockId);
    const words = getWords(block.text);
    const word = words[wordIndex];
    const before = word.slice(0, cursorPos);
    const after = word.slice(cursorPos);

    const newWords = [...words];
    newWords.splice(wordIndex, 1, before, after);
    const newText = newWords.join(' ');

    const nextChords = {};
    Object.keys(chords).forEach((key) => {
      const prefix = `${blockId}-`;
      if (!key.startsWith(prefix)) {
        nextChords[key] = chords[key];
        return;
      }
      const idx = Number(key.slice(prefix.length));
      nextChords[idx > wordIndex ? `${blockId}-${idx + 1}` : key] = chords[key];
    });

    setChords(nextChords);
    setBlocks(blocks.map((b) => (b.id === blockId ? { ...b, text: newText } : b)));

    const globalIndex = blocks.findIndex((b) => b.id === blockId);
    const lines = lyrics.split('\n');
    lines[globalIndex] = newText;
    setLyrics(lines.join('\n'));

    pendingFocusKeyRef.current = `word-${blockId}-${wordIndex + 1}`;
    markDirty();
  };

  // Backspace at the very start of a word (not the line's first word, that merges the
  // line instead) joins it onto the end of the previous word - the reverse of a space-split.
  const mergeWordIntoPrevious = (blockId, wordIndex) => {
    const block = blocks.find((b) => b.id === blockId);
    const words = getWords(block.text);
    if (wordIndex <= 0 || wordIndex >= words.length) return;

    const newWords = [...words];
    newWords.splice(wordIndex - 1, 2, words[wordIndex - 1] + words[wordIndex]);
    const newText = newWords.join(' ');

    const nextChords = {};
    Object.keys(chords).forEach((key) => {
      const prefix = `${blockId}-`;
      if (!key.startsWith(prefix)) {
        nextChords[key] = chords[key];
        return;
      }
      const idx = Number(key.slice(prefix.length));
      if (idx < wordIndex - 1) {
        nextChords[key] = chords[key];
      } else if (idx === wordIndex - 1) {
        nextChords[key] = chords[key];
      } else if (idx === wordIndex) {
        if (!chords[`${blockId}-${wordIndex - 1}`]) {
          nextChords[`${blockId}-${wordIndex - 1}`] = chords[key];
        }
      } else {
        nextChords[`${blockId}-${idx - 1}`] = chords[key];
      }
    });

    setChords(nextChords);
    setBlocks(blocks.map((b) => (b.id === blockId ? { ...b, text: newText } : b)));

    const globalIndex = blocks.findIndex((b) => b.id === blockId);
    const lines = lyrics.split('\n');
    lines[globalIndex] = newText;
    setLyrics(lines.join('\n'));

    pendingFocusKeyRef.current = `word-${blockId}-${wordIndex - 1}`;
    markDirty();
  };

  const DELETE_PASSWORD = 'bye';
  const confirmWithPassword = (message) => {
    if (!window.confirm(message)) return false;
    const entered = window.prompt('Enter the password to confirm:');
    if (entered === null) return false;
    if (entered !== DELETE_PASSWORD) {
      window.alert('Incorrect password.');
      return false;
    }
    return true;
  };

  const handleDeleteSong = (songId) => {
    if (!confirmWithPassword('Delete this song from your songbook?')) return;
    setSavedSongs(savedSongs.filter((song) => song.id !== songId));
    deleteSong(songId).catch(() => {
      window.alert('Could not delete this song from the database. Check your connection and try again.');
    });
    if (activeSongId === songId) {
      setActiveSongId(null);
      setTitle('');
      setArtist('');
      setLyrics('');
      setBlocks([]);
      setChords({});
      setSections({});
      setInstrumentalChords({});
      setIsEditingSong(false);
      setStep('browse');
    }
  };

  if (!isLoaded) {
    return (
      <div style={{ padding: '40px', maxWidth: '600px', margin: '0 auto' }}>
        <p style={{ color: '#666' }}>{loadError ? 'Could not load your songs and setlists. Check your connection and reload.' : 'Loading...'}</p>
      </div>
    );
  }

  if (step === 'home') {
    return (
      <div style={{ padding: '40px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
          {user ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {user.picture && <img src={user.picture} alt="avatar" style={{ width: '32px', height: '32px', borderRadius: '50%' }} />}
              <span style={{ fontSize: '14px' }}><strong>{user.name}</strong></span>
              <button onClick={() => signOut(auth)} style={{ fontSize: '13px' }}>Sign out</button>
            </div>
          ) : (
            <GoogleLogin
              onSuccess={(credentialResponse) => {
                const credential = GoogleAuthProvider.credential(credentialResponse.credential);
                signInWithCredential(auth, credential);
              }}
              onError={() => {
                console.log('Sign in failed');
              }}
            />
          )}
        </div>
        <h1>Home</h1>
        <p style={{ color: '#666', marginBottom: '24px' }}>
          Choose where you want to go next.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <button onClick={() => { if (user) { setSignInPrompt(''); setStep('browse'); } else { setSignInPrompt('You must be signed in to browse songs.'); signInWithPopup(auth, new GoogleAuthProvider()).then(() => setSignInPrompt('')); } }} style={{ padding: '12px 16px', fontSize: '15px' }}>
            Browse Songs
          </button>
          <button onClick={() => { if (user) { setSignInPrompt(''); startNewSong(); } else { setSignInPrompt('You must be signed in to add a song.'); signInWithPopup(auth, new GoogleAuthProvider()).then(() => setSignInPrompt('')); } }} style={{ padding: '12px 16px', fontSize: '15px' }}>
            Add Song
          </button>
          <button onClick={() => { if (user) { setSignInPrompt(''); setStep('setlists'); } else { setSignInPrompt('You must be signed in to view setlists.'); signInWithPopup(auth, new GoogleAuthProvider()).then(() => setSignInPrompt('')); } }} style={{ padding: '12px 16px', fontSize: '15px' }}>
            Go to Setlists
          </button>
        </div>
        {signInPrompt && (
          <p style={{ marginTop: '16px', color: '#c0392b', fontSize: '14px' }}>{signInPrompt}</p>
        )}
      </div>
    );
  }

  if (step === 'input') {
    return (
      <div style={{ padding: '40px', maxWidth: '600px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h1 style={{ margin: 0 }}>Add a Song</h1>
          <button onClick={goHome} style={{ fontSize: '13px' }}>
            Back to Home
          </button>
        </div>
        <div style={{ marginBottom: '15px' }}>
          <label htmlFor="song-title">Song Title</label><br />
          <input id="song-title" type="text" value={title} onChange={(e) => { setTitle(e.target.value); markDirty(); }} style={{ width: '100%', padding: '8px' }} />
        </div>
        <div style={{ marginBottom: '15px' }}>
          <label htmlFor="artist-name">Artist</label><br />
          <input id="artist-name" type="text" value={artist} onChange={(e) => { setArtist(e.target.value); markDirty(); }} style={{ width: '100%', padding: '8px' }} />
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '15px' }}>
          <div style={{ flex: 1, minWidth: '120px' }}>
            <label htmlFor="song-key">Key</label><br />
            <input id="song-key" type="text" value={keySignature} onChange={(e) => { setKeySignature(e.target.value); markDirty(); }} style={{ width: '100%', padding: '8px' }} />
          </div>
          <div style={{ flex: 1, minWidth: '100px' }}>
            <label htmlFor="song-bpm">BPM</label><br />
            <input id="song-bpm" type="number" value={bpm} onChange={(e) => { setBpm(e.target.value); markDirty(); }} style={{ width: '100%', padding: '8px' }} />
          </div>
          <div style={{ flex: 1, minWidth: '100px' }}>
            <label htmlFor="song-length">Length</label><br />
            <input id="song-length" type="text" value={length} onChange={(e) => { setLength(e.target.value); markDirty(); }} placeholder="m:ss" style={{ width: '100%', padding: '8px' }} />
          </div>
        </div>
        <div style={{ marginBottom: '15px' }}>
          <label htmlFor="song-lyrics">Lyrics</label><br />
          <textarea id="song-lyrics" value={lyrics} onChange={(e) => { setLyrics(e.target.value); markDirty(); }} rows={10} style={{ width: '100%', padding: '8px' }} />
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
          <button onClick={startChords}>Continue to Chords</button>
          <button onClick={saveCurrentSong}>Save Song</button>
        </div>
      </div>
    );
  }

  if (step === 'browse') {
    const filteredSongs = savedSongs.filter((song) => {
      const haystack = `${song.title} ${song.artist} ${song.keySignature || ''} ${song.bpm || ''} ${song.length || ''} ${song.addedBy || ''}`.toLowerCase();
      const matchesSearch = haystack.includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;
      if (browseFilter === 'mine') return song.addedBy === user?.name;
      if (browseFilter === 'favorites') return favorites.includes(song.id);
      return true;
    });

    const sortedSongs = [...filteredSongs].sort((a, b) => {
      const direction = sortDirection === 'asc' ? 1 : -1;
      const getValue = (song) => {
        switch (sortKey) {
          case 'title':
            return (song.title || '').toLowerCase();
          case 'artist':
            return (song.artist || '').toLowerCase();
          case 'key':
            return (song.keySignature || '').toLowerCase();
          case 'length':
            return (song.length || '').toLowerCase();
          case 'bpm':
            return Number(song.bpm || 0);
          case 'createdAt':
            return new Date(song.createdAt || 0).getTime();
          case 'addedBy':
            return (song.addedBy || '').toLowerCase();
          case 'updatedAt':
          default:
            return new Date(song.updatedAt || song.createdAt || 0).getTime();
        }
      };

      const aValue = getValue(a);
      const bValue = getValue(b);

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return aValue.localeCompare(bValue) * direction;
      }

      return (aValue > bValue ? 1 : aValue < bValue ? -1 : 0) * direction;
    });

    const handleSort = (key) => {
      if (sortKey === key) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDirection('asc');
      }
    };

    return (
      <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h1 style={{ margin: 0 }}>Songs</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              {[['all', 'All Charts'], ['mine', 'My Charts']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setBrowseFilter(key)}
                  style={{ padding: '5px 12px', fontSize: '13px', borderRadius: '14px', border: browseFilter === key ? 'none' : '1px solid #ddd', background: browseFilter === key ? '#333' : 'transparent', color: browseFilter === key ? '#fff' : '#666', cursor: 'pointer' }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button onClick={goHome}>Back to Home</button>
          </div>
        </div>
        <div style={{ color: '#666', fontSize: '14px', marginBottom: '16px' }}>
          {savedSongs.length} song{savedSongs.length === 1 ? '' : 's'} · {getSetlistTotalTime(savedSongs)} total
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by song, artist, key, or more"
            style={{ flex: 1, minWidth: '240px', padding: '8px' }}
          />
          <button onClick={addSelectedSongsToSetlist} disabled={selectedSongIds.length === 0}>
            Add selected to setlist
          </button>
        </div>
        {filteredSongs.length === 0 ? (
          <div style={{ padding: '12px 0' }}>
            <span style={{ color: '#666' }}>
              {browseFilter === 'favorites'
                ? 'No favorites yet — star a song to add it here.'
                : browseFilter === 'mine'
                  ? "You haven't added any songs yet."
                  : 'No songs yet. Save one from the Add Song page.'}
            </span>
            {browseFilter !== 'all' && (
              <button
                onClick={() => setBrowseFilter('all')}
                style={{ marginLeft: '12px', background: 'transparent', border: '1px solid #ccc', borderRadius: '12px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', color: '#555' }}
              >View all charts</button>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '40px auto 1.4fr 1fr 0.7fr 0.7fr 0.7fr 1fr 1fr', gap: '8px', padding: '8px 0', borderBottom: '1px solid #ddd', fontSize: '14px', fontWeight: 'bold', color: '#666', fontFamily: 'inherit' }}>
              <span />
              <button
                onClick={() => setBrowseFilter((f) => f === 'favorites' ? 'all' : 'favorites')}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px', color: browseFilter === 'favorites' ? '#f5c518' : '#ccc', padding: 0, lineHeight: 1 }}
                title="Filter favorites"
              >★</button>
              <button onClick={() => handleSort('title')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>Title</button>
              <button onClick={() => handleSort('artist')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>Artist</button>
              <button onClick={() => handleSort('key')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>Key</button>
              <button onClick={() => handleSort('length')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>Length</button>
              <button onClick={() => handleSort('bpm')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>BPM</button>
              <button onClick={() => handleSort('createdAt')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>Added</button>
              <button onClick={() => handleSort('addedBy')} style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}>Added By</button>
            </div>
            {sortedSongs.map((song) => (
              <div key={song.id} style={{ display: 'grid', gridTemplateColumns: '40px auto 1.4fr 1fr 0.7fr 0.7fr 0.7fr 1fr 1fr', gap: '8px', padding: '10px 0', borderBottom: '1px solid #eee', alignItems: 'center', fontFamily: 'inherit', fontSize: '14px' }}>
                <input
                  type="checkbox"
                  checked={selectedSongIds.includes(song.id)}
                  onChange={() => toggleSongSelection(song.id)}
                  aria-label={`Select ${song.title || 'Untitled Song'}`}
                />
                <button
                  onClick={() => toggleFavorite(song.id)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', color: favorites.includes(song.id) ? '#f5c518' : '#ccc', padding: 0, lineHeight: 1 }}
                  aria-label={favorites.includes(song.id) ? 'Unfavorite' : 'Favorite'}
                >
                  {favorites.includes(song.id) ? '★' : '☆'}
                </button>
                <button
                  onClick={() => openSongForPreview(song)}
                  style={{ textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 'bold', fontFamily: 'inherit', fontSize: '14px' }}
                >
                  {song.title || 'Untitled Song'}
                </button>
                <div style={{ color: '#666', fontFamily: 'inherit', fontSize: '14px' }}>{song.artist || '—'}</div>
                <div style={{ fontFamily: 'inherit', fontSize: '14px' }}>{song.keySignature || '—'}</div>
                <div style={{ fontFamily: 'inherit', fontSize: '14px' }}>{song.length || '—'}</div>
                <div style={{ fontFamily: 'inherit', fontSize: '14px' }}>{song.bpm || '—'}</div>
                <div style={{ color: '#666', fontFamily: 'inherit', fontSize: '14px' }}>{song.createdAt ? new Date(song.createdAt).toLocaleDateString() : '—'}</div>
                <div style={{ color: '#666', fontFamily: 'inherit', fontSize: '14px' }}>{song.addedBy || '—'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (step === 'setlists') {
    const createNewSetlist = () => {
      const createdName = window.prompt('Name your new setlist:', `Setlist ${setlists.length + 1}`);
      if (createdName === null) return;
      const trimmedName = createdName.trim() || `Setlist ${setlists.length + 1}`;
      const nextSetlist = {
        id: `setlist-${Date.now()}`,
        name: trimmedName,
        songs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      persistSetlists([...setlists, nextSetlist]);
      setActiveSetlistId(nextSetlist.id);
      setStep('setlistDetail');
    };

    const openSetlist = (listId) => {
      setActiveSetlistId(listId);
      setStep('setlistDetail');
    };

    return (
      <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h1 style={{ margin: 0 }}>Setlists</h1>
          <button onClick={goHome}>Back to Home</button>
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <button onClick={createNewSetlist}>Create New Setlist</button>
          <button onClick={() => setStep('browse')}>Back to Songs</button>
        </div>
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.7fr 0.7fr 1fr 1fr', gap: '8px', padding: '8px 0', borderBottom: '1px solid #ddd', fontSize: '14px', fontWeight: 'bold', color: '#666', fontFamily: 'inherit' }}>
            <span>Title</span>
            <span>Songs</span>
            <span>Length</span>
            <span>Date Added</span>
            <span>Date Updated</span>
          </div>
          {[
            { id: '__favorites__', name: '★ Favorites', songs: savedSongs.filter((s) => favorites.includes(s.id)) },
            { id: '__mine__', name: '♪ My Songs', songs: savedSongs.filter((s) => s.addedBy === user?.name) },
          ].map((smart) => (
            <button
              key={smart.id}
              onClick={() => { setActiveSetlistId(smart.id); setStep('setlistDetail'); }}
              style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.7fr 0.7fr 1fr 1fr', gap: '8px', width: '100%', textAlign: 'left', background: '#f7f7f7', border: 'none', borderBottom: '1px solid #eee', padding: '10px 0', cursor: 'pointer', alignItems: 'center', fontFamily: 'inherit', fontSize: '14px' }}
            >
              <span style={{ fontWeight: 'bold' }}>{smart.name}</span>
              <span>{smart.songs.length}</span>
              <span>{getSetlistTotalTime(smart.songs)}</span>
              <span style={{ color: '#999', fontStyle: 'italic' }}>Auto</span>
              <span style={{ color: '#999', fontStyle: 'italic' }}>Auto</span>
            </button>
          ))}
          {setlists.length > 0 && setlists.map((list) => {
            const resolvedSongs = (list.songs || []).map((song) => {
              const latest = savedSongs.find((candidate) => candidate.id === song.songId || candidate.id === song.id);
              return latest ? { ...song, ...latest } : song;
            });
            return (
              <button
                key={list.id}
                onClick={() => openSetlist(list.id)}
                style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.7fr 0.7fr 1fr 1fr', gap: '8px', width: '100%', textAlign: 'left', background: '#fff', border: 'none', borderBottom: '1px solid #eee', padding: '10px 0', cursor: 'pointer', alignItems: 'center', fontFamily: 'inherit', fontSize: '14px' }}
              >
                <span style={{ fontWeight: 'bold' }}>{list.name}</span>
                <span>{resolvedSongs.length}</span>
                <span>{getSetlistTotalTime(resolvedSongs)}</span>
                <span style={{ color: '#666' }}>{list.createdAt ? new Date(list.createdAt).toLocaleDateString() : '—'}</span>
                <span style={{ color: '#666' }}>{list.updatedAt ? new Date(list.updatedAt).toLocaleDateString() : '—'}</span>
              </button>
            );
          })}
          {setlists.length === 0 && (
            <div style={{ color: '#666', padding: '12px 0' }}>No setlists yet. Select songs from the Songs page to start one.</div>
          )}
        </div>
      </div>
    );
  }

  if (step === 'setlistDetail' && (activeSetlistId === '__favorites__' || activeSetlistId === '__mine__')) {
    const isFavorites = activeSetlistId === '__favorites__';
    const smartName = isFavorites ? '★ Favorites' : '♪ My Songs';
    const smartSongs = isFavorites
      ? savedSongs.filter((s) => favorites.includes(s.id))
      : savedSongs.filter((s) => s.addedBy === user?.name);

    return (
      <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h1 style={{ margin: 0 }}>{smartName}</h1>
          <button onClick={() => setStep('setlists')}>Back to Setlists</button>
        </div>
        {smartSongs.length === 0 ? (
          <div style={{ color: '#666' }}>
            {isFavorites ? 'No favorites yet. Star songs from the browse list.' : 'No songs added by you yet.'}
          </div>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.7fr 0.7fr 0.7fr', gap: '8px', padding: '8px 0', borderBottom: '1px solid #ddd', fontSize: '14px', fontWeight: 'bold', color: '#666', fontFamily: 'inherit' }}>
              <span>Song</span>
              <span>Artist</span>
              <span>Key</span>
              <span>Length</span>
              <span>BPM</span>
            </div>
            {smartSongs.map((song) => (
              <div key={song.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.7fr 0.7fr 0.7fr', gap: '8px', padding: '10px 0', borderBottom: '1px solid #eee', alignItems: 'center', fontFamily: 'inherit', fontSize: '14px' }}>
                <div style={{ fontWeight: 'bold' }}>{song.title || 'Untitled Song'}</div>
                <div style={{ color: '#666' }}>{song.artist || '—'}</div>
                <div>{song.keySignature || '—'}</div>
                <div>{song.length || '—'}</div>
                <div>{song.bpm || '—'}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: '16px', fontWeight: 'bold' }}>Total time: {getSetlistTotalTime(smartSongs)}</div>
      </div>
    );
  }

  if (step === 'setlistDetail') {
    const activeSetlist = setlists.find((list) => list.id === activeSetlistId);
    const resolvedSetlistSongs = (activeSetlist?.songs || []).map((song) => {
      const latest = savedSongs.find((candidate) => candidate.id === song.songId || candidate.id === song.id);
      return latest ? { ...song, ...latest, id: song.id || latest.id, songId: song.songId || latest.id } : song;
    });

    if (!activeSetlist) {
      return (
        <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
          <div style={{ color: '#666' }}>Setlist not found.</div>
          <button onClick={() => setStep('setlists')}>Back to Setlists</button>
        </div>
      );
    }

    return (
      <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 style={{ margin: 0 }}>{activeSetlist.name}</h1>
            <button onClick={() => renameSetlist(activeSetlist.id)} style={{ fontSize: '13px' }}>
              Rename
            </button>
          </div>
          <button onClick={() => setStep('setlists')}>Back to Setlists</button>
        </div>
        {resolvedSetlistSongs.length === 0 ? (
          <div style={{ color: '#666' }}>This setlist is empty. Pick songs from the browse list to add them here.</div>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.7fr 0.7fr 0.7fr auto', gap: '8px', padding: '8px 0', borderBottom: '1px solid #ddd', fontSize: '14px', fontWeight: 'bold', color: '#666', fontFamily: 'inherit' }}>
              <span>Song</span>
              <span>Artist</span>
              <span>Key</span>
              <span>Length</span>
              <span>BPM</span>
              <span>Move</span>
            </div>
            {resolvedSetlistSongs.map((song, index) => (
              <div key={`${song.id}-${index}`} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.7fr 0.7fr 0.7fr auto', gap: '8px', padding: '10px 0', borderBottom: '1px solid #eee', alignItems: 'center', fontFamily: 'inherit', fontSize: '14px' }}>
                <div style={{ fontWeight: 'bold' }}>{song.title || 'Untitled Song'}</div>
                <div style={{ color: '#666' }}>{song.artist || '—'}</div>
                <div>{song.keySignature || '—'}</div>
                <div>{song.length || '—'}</div>
                <div>{song.bpm || '—'}</div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', fontSize: '16px' }}>
                  <span
                    onClick={() => index > 0 && moveSetlistSong(activeSetlist.id, index, -1)}
                    style={{ cursor: index === 0 ? 'default' : 'pointer', color: index === 0 ? '#ccc' : '#333' }}
                  >
                    ↑
                  </span>
                  <span
                    onClick={() => index < resolvedSetlistSongs.length - 1 && moveSetlistSong(activeSetlist.id, index, 1)}
                    style={{ cursor: index === resolvedSetlistSongs.length - 1 ? 'default' : 'pointer', color: index === resolvedSetlistSongs.length - 1 ? '#ccc' : '#333' }}
                  >
                    ↓
                  </span>
                  <span
                    onClick={() => setPendingRemoveSetlistSong({ setlistId: activeSetlist.id, index })}
                    style={{ cursor: 'pointer', color: '#999', fontSize: '18px', lineHeight: 1 }}
                  >
                    −
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: '16px', fontWeight: 'bold' }}>Total time: {getSetlistTotalTime(resolvedSetlistSongs || [])}</div>

        {pendingRemoveSetlistSong && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', maxWidth: '320px' }}>
              <p style={{ marginTop: 0 }}>Would you like to remove this from the setlist?</p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setPendingRemoveSetlistSong(null)}>No</button>
                <button onClick={() => {
                  removeSetlistSong(pendingRemoveSetlistSong.setlistId, pendingRemoveSetlistSong.index);
                  setPendingRemoveSetlistSong(null);
                }}>
                  Yes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === 'preview') {
    const previewActionButtons = (
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={goToEditor}>
          Edit Chords
        </button>
        <button onClick={goToLyrics}>
          Edit Lyrics
        </button>
        <button onClick={() => saveCurrentSong({ stayOnPreview: true })}>
          Save to Songs
        </button>
      </div>
    );

    return (
      <div style={{ padding: '40px', maxWidth: '700px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>Final View</h2>
          <button onClick={() => confirmBeforeLeaving('browse')}>Back to Songs</button>
        </div>
        <div style={{ marginBottom: '16px' }}>
          {previewActionButtons}
        </div>
        <h1 style={{ marginBottom: '4px', fontSize: '28px' }}>{title}</h1>
        {artist && <p style={{ color: '#666', marginTop: 0, marginBottom: '20px', fontSize: '15px' }}>{artist}</p>}

        {blocks.map((block) => {
          const isInstrumental = block.text.trim() === '';
          const words = isInstrumental ? [] : getDisplayWords(getWords(block.text), block.id, chords).slice(0, -1);
          const sectionLabel = sections[block.id];
          const slots = instrumentalChords[block.id] || [];
          const hasVisibleChords = slots.some((chord) => chord); // for instrumental
          const hasChordRow = isInstrumental
            ? hasVisibleChords
            : words.some((_, wordIndex) => chords[`${block.id}-${wordIndex}`]) || slots.some((chord) => chord);
          const bottomMargin = isInstrumental ? (hasVisibleChords ? '12px' : '4px') : '2px';

          return (
            <div key={block.id} style={{ marginBottom: bottomMargin }}>
              {sectionLabel && (
                <div style={{ marginTop: '18px', marginBottom: '5px' }}>
                  <span style={{
                    display: 'inline-block',
                    fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em',
                    color: '#111', textTransform: 'uppercase',
                    fontFamily: 'inherit', padding: '2px 8px', borderRadius: '4px',
                    border: '1.5px solid #ccc',
                  }}>
                    {sectionLabel}
                  </span>
                </div>
              )}

              {isInstrumental ? (
                hasVisibleChords ? (
                <div style={{ display: 'flex', gap: '16px' }}>
                  {slots.map((chord, slotIndex) => (
                    chord && (
                      <div key={slotIndex} style={{ color: CHORD_COLOR, fontWeight: '600', fontSize: '13px' }}>
                        {chord}
                      </div>
                    )
                  ))}
                </div>
                ) : null
              ) : hasChordRow ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: '5px' }}>
                  {words.map((word, wordIndex) => {
                    const chord = chords[`${block.id}-${wordIndex}`];
                    return (
                      <span key={wordIndex} style={{ display: 'inline-flex', flexDirection: 'column' }}>
                        <span style={{
                          display: 'block', minHeight: '13px',
                          color: CHORD_COLOR, fontWeight: '600', fontSize: '13px',
                          whiteSpace: 'nowrap', lineHeight: 1,
                        }}>
                          {chord || ''}
                        </span>
                        <span style={{ fontSize: '16px', lineHeight: '1.4' }}>{word || ' '}</span>
                      </span>
                    );
                  })}
                  {slots.filter(c => c).map((chord, slotIndex) => (
                    <span key={`extra-${slotIndex}`} style={{ display: 'inline-flex', flexDirection: 'column' }}>
                      <span style={{
                        display: 'block',
                        color: CHORD_COLOR, fontWeight: '600', fontSize: '13px',
                        whiteSpace: 'nowrap', lineHeight: 1,
                      }}>
                        {chord}
                      </span>
                      <span style={{ fontSize: '16px', lineHeight: '1.4' }}>&nbsp;</span>
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '16px', lineHeight: '1.4' }}>{block.text}</div>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: '20px' }}>
          {previewActionButtons}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '40px', maxWidth: '700px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h1 style={{ margin: 0 }}>{title} {artist && `- ${artist}`}</h1>
        <button onClick={goHome}>Back to Home</button>
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div>
          <label htmlFor="song-key" style={{ fontSize: '13px' }}>Key</label><br />
          <input id="song-key" type="text" value={keySignature} onChange={(e) => { setKeySignature(e.target.value); markDirty(); }} style={{ width: '90px', padding: '6px' }} />
        </div>
        <div>
          <label htmlFor="song-bpm" style={{ fontSize: '13px' }}>BPM</label><br />
          <input id="song-bpm" type="number" value={bpm} onChange={(e) => { setBpm(e.target.value); markDirty(); }} style={{ width: '70px', padding: '6px' }} />
        </div>
        <div>
          <label htmlFor="song-length" style={{ fontSize: '13px' }}>Length</label><br />
          <input id="song-length" type="text" value={length} onChange={(e) => { setLength(e.target.value); markDirty(); }} placeholder="m:ss" style={{ width: '80px', padding: '6px' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <button onClick={goToLyrics}>Edit Lyrics</button>
        <button onClick={saveEditedSong}>Save</button>
        <button onClick={goToPreview}>Preview</button>
      </div>
      <p style={{ color: '#666' }}>Type a chord directly. Hover ▶ on the left of any line to mark it as a section start — the box covers everything until the next section. Hover the thin gaps between lines to insert a new line.</p>

      <InsertBar onClick={() => insertEmptyLineAt(0)} />

      {(() => {
        const sectionGroups = groupBlocksIntoSections(blocks, sections);
        let globalIndex = 0;

        const renderBlockContent = (block) => {
          const words = getWords(block.text);
          const isInstrumental = block.text.trim() === '';
          const slots = instrumentalChords[block.id] || [];
          const currentGlobalIndex = globalIndex;
          globalIndex += 1;
          const isSectionStart = sections[block.id] !== undefined;

          return (
            <React.Fragment key={block.id}>
              <div style={{ marginBottom: '8px', display: 'flex', alignItems: 'flex-start' }}>
                <SectionToggleStrip
                  isSectionStart={isSectionStart}
                  onToggle={() => toggleSectionAt(block.id)}
                />
                <div style={{ flex: 1 }}>
                  {isInstrumental ? (
                    <div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <ChordSlotRow
                          blockId={block.id}
                          slots={slots}
                          onChange={(slotIndex, value) => updateInstrumentalChordValue(block.id, slotIndex, value)}
                          onRemove={(slotIndex) => removeInstrumentalSlot(block.id, slotIndex)}
                          onEnter={() => insertEmptyLineAt(currentGlobalIndex + 1)}
                          onDeleteLine={() => deleteEmptyBlock(block.id, currentGlobalIndex)}
                        />
                      </div>
                      <input
                        key={`lyric-convert-${block.id}`}
                        defaultValue=""
                        placeholder="add lyrics…"
                        onChange={(e) => {
                          if (e.target.value) convertInstrumentalToLyric(block.id, e.target.value, currentGlobalIndex);
                        }}
                        style={{
                          display: 'block', fontSize: '14px', color: '#aaa', fontFamily: 'inherit',
                          border: 'none', borderBottom: '1px dashed transparent', background: 'transparent',
                          outline: 'none', padding: '2px 0', marginTop: '2px', width: '160px', cursor: 'text',
                        }}
                        onFocus={(e) => { e.target.style.borderBottomColor = '#ddd'; }}
                        onBlur={(e) => { e.target.style.borderBottomColor = 'transparent'; }}
                      />
                    </div>
                  ) : (
                    <div style={{ paddingTop: '18px', position: 'relative' }}>
                      {getDisplayWords(words, block.id, chords).map((word, wordIndex) => (
                        <span key={wordIndex} style={{ position: 'relative', display: 'inline-block', marginRight: '5px', minWidth: '56px' }}>
                          <input
                            data-key={`${block.id}-${wordIndex}`}
                            data-block-id={block.id}
                            value={chords[`${block.id}-${wordIndex}`] || ''}
                            onChange={(e) => updateChordValue(block.id, wordIndex, e.target.value)}
                            onKeyDown={(e) => {
                              focusCounterpartOnVerticalArrow(e, `word-${block.id}-${wordIndex}`);
                              if (e.shiftKey && e.key === 'Enter') {
                                focusNextLineOnShiftEnter(e);
                                return;
                              }
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                splitBlockAtWord(currentGlobalIndex, wordIndex);
                                return;
                              }
                              if (e.key === ' ') {
                                e.preventDefault();
                                insertWordAt(block.id, wordIndex);
                                return;
                              }
                              if (
                                e.key === 'Backspace' && wordIndex === 0
                                && e.target.selectionStart === 0 && e.target.selectionEnd === 0
                              ) {
                                e.preventDefault();
                                mergeBlockIntoPrevious(currentGlobalIndex);
                              }
                            }}
                            style={CHORD_INPUT_STYLE}
                          />
                          <input
                            data-key={`word-${block.id}-${wordIndex}`}
                            data-block-id={block.id}
                            tabIndex={-1}
                            value={word}
                            size={Math.max(word.length, 1)}
                            onChange={(e) => updateWordText(block.id, wordIndex, e.target.value)}
                            onKeyDown={(e) => {
                              focusCounterpartOnVerticalArrow(e, `${block.id}-${wordIndex}`);
                              focusAdjacentWordOnTab(e);
                              if (e.shiftKey && e.key === 'Enter') {
                                focusNextLineOnShiftEnter(e);
                                return;
                              }
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                splitBlockAtWord(currentGlobalIndex, wordIndex);
                                return;
                              }
                              if (e.key === ' ') {
                                e.preventDefault();
                                splitWordAt(block.id, wordIndex, e.target.selectionStart);
                                return;
                              }
                              if (e.key === 'ArrowRight' && e.target.selectionStart === e.target.value.length) {
                                const next = document.querySelector(`[data-key="word-${block.id}-${wordIndex + 1}"]`);
                                if (next) {
                                  e.preventDefault();
                                  next.focus();
                                  next.setSelectionRange(0, 0);
                                }
                                return;
                              }
                              if (e.key === 'ArrowLeft' && e.target.selectionStart === 0 && wordIndex > 0) {
                                const prev = document.querySelector(`[data-key="word-${block.id}-${wordIndex - 1}"]`);
                                if (prev) {
                                  e.preventDefault();
                                  prev.focus();
                                  prev.setSelectionRange(prev.value.length, prev.value.length);
                                }
                                return;
                              }
                              if (
                                e.key === 'Backspace'
                                && e.target.selectionStart === 0 && e.target.selectionEnd === 0
                              ) {
                                e.preventDefault();
                                if (wordIndex === 0) {
                                  mergeBlockIntoPrevious(currentGlobalIndex);
                                } else {
                                  mergeWordIntoPrevious(block.id, wordIndex);
                                }
                              }
                            }}
                            style={WORD_INPUT_STYLE}
                          />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        };

        return sectionGroups.map((group) => {
          const firstBlock = group.blocks[0];
          const isEditingThisLabel = editingSectionBlockId === firstBlock.id;
          const hasSection = group.label !== null; // null = no section, '' = unnamed section, string = named

          return (
            <React.Fragment key={firstBlock.id}>
              {hasSection && (
                <div style={{ marginTop: '22px', marginBottom: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {!isEditingThisLabel ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      <span
                        onClick={() => setEditingSectionBlockId(firstBlock.id)}
                        style={{
                          cursor: 'pointer', fontSize: '11px', fontWeight: '600', letterSpacing: '0.08em',
                          color: group.label ? '#111' : '#aaa',
                          textTransform: 'uppercase', fontFamily: 'inherit',
                          padding: '2px 8px', borderRadius: '4px',
                          border: `1.5px solid ${group.label ? '#ccc' : '#ddd'}`,
                        }}
                      >
                        {group.label || '+ name'}
                      </span>
                      <span
                        onClick={() => removeSection(firstBlock.id)}
                        style={{ cursor: 'pointer', fontSize: '10px', color: '#bbb', lineHeight: 1 }}
                        title="Remove section"
                      >✕</span>
                    </div>
                  ) : (
                    <input
                      data-key={`section-${firstBlock.id}`}
                      value={sections[firstBlock.id] || ''}
                      placeholder="Section name"
                      onChange={(e) => { setSections({ ...sections, [firstBlock.id]: e.target.value }); markDirty(); }}
                      onFocus={() => setEditingSectionBlockId(firstBlock.id)}
                      onBlur={() => setEditingSectionBlockId(null)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditingSectionBlockId(null); } }}
                      style={SECTION_INPUT_STYLE}
                    />
                  )}
                </div>
              )}

              {hasSection ? (
                <div style={{ borderLeft: '2px solid #e0e0e0', paddingLeft: '10px', marginBottom: '6px' }}>
                  {group.blocks.map(renderBlockContent)}
                </div>
              ) : (
                group.blocks.map(renderBlockContent)
              )}
            </React.Fragment>
          );
        });
      })()}

    </div>
  );
}

export default App;