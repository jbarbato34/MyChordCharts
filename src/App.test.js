import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { saveSong } from './utils/songStorage';
import { saveSetlists } from './utils/setlistStorage';

beforeEach(() => {
  window.prompt = jest.fn().mockReturnValue('Am');
});

test('shows the home screen with options to start a song', async () => {
  render(<App />);
  expect(await screen.findByText('Home')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /add song/i })).toBeInTheDocument();
});

test('opens the song editor from the home screen', async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /add song/i }));

  expect(screen.getByText('Add a Song')).toBeInTheDocument();
  expect(screen.getByLabelText('Song Title')).toBeInTheDocument();
  expect(screen.getByLabelText('Artist')).toBeInTheDocument();
});

test('starts a fresh blank song when choosing add song again', async () => {
  window.confirm = jest.fn(() => true);

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /add song/i }));
  await userEvent.type(screen.getByLabelText('Song Title'), 'My Song');
  await userEvent.type(screen.getByLabelText('Artist'), 'Test Artist');
  await userEvent.type(screen.getByLabelText(/lyrics/i), 'Hello world');
  await userEvent.click(screen.getByRole('button', { name: /back to home/i }));
  await userEvent.click(screen.getByRole('button', { name: /add song/i }));

  expect(screen.getByLabelText('Song Title')).toHaveValue('');
  expect(screen.getByLabelText('Artist')).toHaveValue('');
  expect(screen.getByLabelText(/lyrics/i)).toHaveValue('');
});

test('creates a setlist from the selected browse songs', async () => {
  await saveSong({
    id: 'song-1',
    title: 'Set Song',
    artist: 'Set Artist',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: {},
    sections: {},
    instrumentalChords: {},
    keySignature: 'G',
    bpm: '80',
    length: '3:10',
  });

  window.prompt = jest.fn().mockReturnValue('Friday Set');
  window.confirm = jest.fn().mockReturnValue(true);

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /browse songs/i }));
  await userEvent.click(await screen.findByRole('checkbox', { name: /select set song/i }));
  await userEvent.click(screen.getByRole('button', { name: /add selected to setlist/i }));

  expect(screen.getByText('Friday Set')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /friday set/i }));

  expect(screen.getByText('Set Song')).toBeInTheDocument();
  expect(screen.getByText(/total time/i)).toBeInTheDocument();
});

test('stays on the songs page when you choose not to open the setlist', async () => {
  await saveSong({
    id: 'song-1',
    title: 'Stay Here',
    artist: 'Test Artist',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: {},
    sections: {},
    instrumentalChords: {},
    keySignature: 'G',
    bpm: '80',
    length: '3:10',
  });

  window.prompt = jest.fn().mockReturnValue('Friday Set');
  window.confirm = jest.fn().mockReturnValue(false);

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /browse songs/i }));
  await userEvent.click(await screen.findByRole('checkbox', { name: /select stay here/i }));
  await userEvent.click(screen.getByRole('button', { name: /add selected to setlist/i }));

  expect(screen.getByText('Songs')).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/search by song, artist, key, or more/i)).toBeInTheDocument();
});

test('keeps setlist entries synced with the latest saved song metadata', async () => {
  await saveSong({
    id: 'song-1',
    title: 'Set Song',
    artist: 'Set Artist',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: {},
    sections: {},
    instrumentalChords: {},
    keySignature: 'C',
    bpm: '100',
    length: '4:20',
  });
  await saveSetlists([
    {
      id: 'setlist-1',
      name: 'Friday Set',
      songs: [{ id: 'song-1', title: 'Old Title', artist: 'Old Artist', keySignature: 'G', bpm: '80', length: '3:10' }],
    },
  ]);

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /go to setlists/i }));
  await userEvent.click(await screen.findByRole('button', { name: /friday set/i }));

  expect(screen.getByText('C')).toBeInTheDocument();
  expect(screen.getByText('100')).toBeInTheDocument();
  expect(screen.getByText('4:20')).toBeInTheDocument();
});

test('opens saved songs from browse into the chord editor', async () => {
  await saveSong({
    id: 'song-1',
    title: 'Saved Song',
    artist: 'Saved Artist',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: { '1-0': 'Am' },
    sections: {},
    instrumentalChords: {},
  });

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /browse songs/i }));
  await userEvent.click(await screen.findByRole('button', { name: /saved song/i }));

  expect(screen.getByText('Final View')).toBeInTheDocument();
  expect(screen.getByText('Am')).toBeInTheDocument();
});

test('shows sortable browse headers', async () => {
  await saveSong({
    id: 'song-1',
    title: 'Beta Song',
    artist: 'Artist B',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: {},
    sections: {},
    instrumentalChords: {},
    keySignature: 'A',
    bpm: '90',
    length: '2:30',
  });

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /browse songs/i }));

  expect(await screen.findByRole('button', { name: /title/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /artist/i })).toBeInTheDocument();
});

test('deletes a song from the browse list', async () => {
  await saveSong({
    id: 'song-1',
    title: 'Delete Me',
    artist: 'Test Artist',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: {},
    sections: {},
    instrumentalChords: {},
  });

  window.confirm = jest.fn(() => true);
  window.prompt = jest.fn(() => 'bye');

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /browse songs/i }));
  await userEvent.click((await screen.findAllByRole('button', { name: /^delete$/i }))[0]);

  expect(screen.getByText(/no songs yet/i)).toBeInTheDocument();
});

test('shows metadata fields on the editor and searches them', async () => {
  await saveSong({
    id: 'song-2',
    title: 'Metadata Song',
    artist: 'Meta Artist',
    lyrics: 'Hello world',
    blocks: [{ id: 1, text: 'Hello world' }],
    chords: {},
    sections: {},
    instrumentalChords: {},
    keySignature: 'D',
    bpm: '92',
    length: '3:12',
  });

  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /browse songs/i }));
  await userEvent.type(await screen.findByPlaceholderText(/search by song, artist, key, or more/i), '92');

  expect(screen.getByText('Metadata Song')).toBeInTheDocument();
});

test('persists chords when reopening a saved song', async () => {
  render(<App />);

  await userEvent.click(await screen.findByRole('button', { name: /add song/i }));
  await userEvent.type(screen.getByLabelText('Song Title'), 'Test Song');
  await userEvent.type(screen.getByLabelText('Artist'), 'Test Artist');
  await userEvent.type(screen.getByLabelText(/lyrics/i), 'Hello world');
  await userEvent.click(screen.getByRole('button', { name: /continue to chords/i }));

  await userEvent.type(screen.getAllByPlaceholderText('+')[0], 'Am');
  await userEvent.click(screen.getAllByRole('button', { name: /save/i })[0]);
  await userEvent.click(screen.getAllByRole('button', { name: /preview/i })[0]);
  await userEvent.click(screen.getByRole('button', { name: /back to songs/i }));
  await userEvent.click(screen.getByRole('button', { name: /test song/i }));

  expect(screen.getByText('Am')).toBeInTheDocument();
});
