import { buildGoogleLyricsSearchUrl, extractLyricsFromText, formatLabel } from './websiteImport';

describe('website import helpers', () => {
  it('keeps lyric-like lines and drops boilerplate', () => {
    const rawText = `
    Google Search
    Home | About | Contact
    It's a little bit funny
    this feeling inside

    How wonderful life is while you're in the world

    © 2024 Example Music
    `;

    const result = extractLyricsFromText(rawText);

    expect(result).toContain("It's a little bit funny");
    expect(result).toContain('this feeling inside');
    expect(result).toContain("How wonderful life is while you're in the world");
    expect(result).not.toContain('Home | About | Contact');
    expect(result).not.toContain('© 2024 Example Music');
  });

  it('builds a Google search URL from title and artist', () => {
    expect(buildGoogleLyricsSearchUrl('Your Song', 'Elton John')).toBe('https://www.google.com/search?q=Elton%20John%20Your%20Song%20lyrics');
  });

  it('formats labels in title case', () => {
    expect(formatLabel('the beatles')).toBe('The Beatles');
    expect(formatLabel('hey jude')).toBe('Hey Jude');
  });
});
