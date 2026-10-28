// Curated CC0 music library (FR-247, ADR-035; QA 2026-10-28 #9/#10). Tracks are downloaded on demand, one file each, from a
// Hugging Face dataset mirror of FreePD.com (closed 2025-12-09) at a PINNED commit, verified by sha256 and exact size like a
// Model Download (SEC-074). Licence proof: FreePD's legal page ("Creative Commons 0 … Free Of Attribution"), archived in the
// same dataset (`page_snapshot/FreePD.com_Legal.pdf`, Wayback 2025-12-02) and the per-track `license` field of its catalogue
// (`pieces.csv` → https://creativecommons.org/publicdomain/zero/1.0/). Tracks whose author also sells / licenses them as CC BY
// elsewhere (Rafael Krux) are left out (Content-ID risk). Attribution is not required by CC0; the credit line is a courtesy.
// Moods / tempo / length come from FreePD's own (machine-tagged) catalogue: approximate.

export const MUSIC_LIBRARY_COMMIT = 'da6aa61dca495ab3b52c30023874e34600d10194';
export const MUSIC_LIBRARY_REPO = 'Youmiel/FreePD-Data';
export const MUSIC_LIBRARY_LICENCE = { spdx: 'CC0-1.0', name: 'CC0 1.0 (public domain dedication)', url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  proofUrl: `https://huggingface.co/datasets/Youmiel/FreePD-Data/resolve/da6aa61dca495ab3b52c30023874e34600d10194/page_snapshot/FreePD.com_Legal.pdf` } as const;
export const MUSIC_MOODS = ['upbeat', 'energetic', 'calm', 'corporate', 'cinematic', 'dramatic', 'lofi', 'electronic', 'acoustic', 'sentimental'] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];
export interface MusicTrack {
  id: string; title: string; artist: string; mood: MusicMood; genre: string; bpm: number; durationS: number;
  url: string; bytes: number; sha256: string; file: string; credit: string;
}
const t = (id: string, title: string, artist: string, mood: MusicMood, genre: string, bpm: number, durationS: number, path: string, bytes: number, sha256: string): MusicTrack => ({
  id, title, artist, mood, genre, bpm, durationS, bytes, sha256, file: `${id}.mp3`,
  url: `https://huggingface.co/datasets/${MUSIC_LIBRARY_REPO}/resolve/${MUSIC_LIBRARY_COMMIT}/music/${path}`,
  credit: `Music: ${title} by ${artist} (FreePD.com, CC0 1.0)`,
});
export const MUSIC_LIBRARY: readonly MusicTrack[] = Object.freeze([
  t('windy-old-weather', 'Windy Old Weather', 'Kevin MacLeod', 'upbeat', 'Jazz', 97, 120, 'World_mp3/Windy%20Old%20Weather.mp3', 2916300, 'afb7f452699f189c885be9ade7710518264893ee197f1c818317db1487b1f3cf'),
  t('village-tarantella', 'Village Tarantella', 'Kevin MacLeod', 'upbeat', 'World', 145, 53, 'World_mp3/Village%20Tarantella.mp3', 1699045, 'd0daa7fdfd629e8dc2b9efcde93dbc2fb4c7cc1c05bf501f523b729582a46b06'),
  t('drop-point', 'Drop Point', 'Bryan Teoh', 'upbeat', 'Jazz', 114, 184, 'Miscellaneaous_mp3/Drop%20Point.mp3', 3685788, '00082677a2ca637d3b415a2afee1a2bad145adaf6b37c44fbf323605c8d84482'),
  t('stunted-adventure', 'Stunted Adventure', 'Bryan Teoh', 'energetic', 'Electronic', 138, 70, 'Underscoring_mp3/Stunted%20Adventure.mp3', 1404835, 'd49752e0c86a2e7aa4a770fec41209f28f562180101647fe9fcd936036435593'),
  t('wisdom-in-the-sun', 'Wisdom in the Sun', 'Kevin MacLeod', 'calm', 'Ambient', 60, 155, 'Miscellaneaous_Chill_mp3/Wisdom%20in%20the%20Sun.mp3', 4953366, '07ac4ab1f6d54893615d48aeee8bb3f2e5c1f2d16c6385973c97b28ef83c7ee0'),
  t('infinite-peace', 'Infinite Peace', 'Kevin MacLeod', 'calm', 'Ambient', 83, 76, 'Miscellaneaous_Chill_mp3/Infinite%20Peace.mp3', 2436321, '542c11bcc82828c3e494b40b07319ed75be457f66f2673dcba4e3643979b1f9f'),
  t('aquarium', 'Aquarium', 'Kevin MacLeod', 'calm', 'Classical', 68, 144, 'Miscellaneaous_Classical_mp3/Aquarium.mp3', 5895241, '1f52f8d577c4ff6cc56c9acef25793c1d15c614dd2625f48772a9f4f63e8583d'),
  t('from-page-to-practice', 'From Page to Practice', 'Bryan Teoh', 'corporate', 'Ambient', 80, 137, 'Uplifting_mp3/From%20Page%20to%20Practice.mp3', 2733479, 'dd20cb51c948a14e45d71b9a03b9d6afc48a4b7fd7b5020da623fbd86390b519'),
  t('connecting-rainbows', 'Connecting Rainbows', 'Kevin MacLeod', 'calm', 'Classical', 90, 116, 'World_mp3/Connecting%20Rainbows.mp3', 4646578, '85f77462ba2ff846ed5bfa911a267f8a8ea0b2c579b58278a2bcef1e26efb81a'),
  t('inventing-flight', 'Inventing Flight', 'Bryan Teoh', 'corporate', 'Electronic', 73, 144, 'Uplifting_mp3/Inventing%20Flight.mp3', 2840034, '916e736efa3caed4ea8534e727670dbac41af0fb44f00fa667aebaab9b2b6407'),
  t('slice-of-life', 'Slice of Life', 'Bryan Teoh', 'corporate', 'Folk', 146, 141, 'Underscoring_mp3/Slice%20of%20Life.mp3', 2817471, '39e0543fbeb06ced8a5f023daf7375385235238ea9063677f3ff71ab15bc04dc'),
  t('strength-of-the-titans', 'Strength of the Titans', 'Kevin MacLeod', 'cinematic', 'Orchestral', 86, 62, 'Epic_Dramatic_mp3/Strength%20of%20the%20Titans.mp3', 2612191, '7b97a9253a244cb1d279c3294269bde3cc4e5971d389df0af0ec969b03fbd52c'),
  t('honor-bound', 'Honor Bound', 'Bryan Teoh', 'cinematic', 'Ambient', 126, 171, 'Epic_Dramatic_mp3/Honor%20Bound.mp3', 3413629, 'd9d592d5bc2b1bb7e69aededa2364b7f5cf108daa58099bd320755bcc1861ebc'),
  t('sunday-dub', 'Sunday Dub', 'Kevin MacLeod', 'lofi', 'Reggae', 102, 209, 'Miscellaneaous_mp3/Sunday%20Dub.mp3', 3355628, '85686c592fd9a79ebb046ad72aad154c4ef7006f874084a56cc9621b1a6ada5c'),
  t('neptunian-princess', 'Neptunian Princess', 'Bryan Teoh', 'lofi', 'Jazz', 100, 125, 'Miscellaneaous_Chill_mp3/Neptunian%20Princess.mp3', 2511236, 'f81ff8af1417ce13b5d06db0b1440c50b65a88b9f14d61fdf9012ec96ff423ce'),
  t('hold-on-a-sec', 'Hold on a Sec', 'Bryan Teoh', 'lofi', 'Funk', 96, 126, 'Miscellaneaous_Jazz_mp3/Hold%20on%20a%20Sec.mp3', 2512598, 'c87d50579aa12c8c2f44f0129bf8ec9cb4b5cc856a8afdf2620ef57bf96fc53c'),
  t('downtown-boogie', 'Downtown Boogie', 'Bryan Teoh', 'lofi', 'Funk', 106, 147, 'Miscellaneaous_Chill_mp3/Downtown%20Boogie.mp3', 2949473, 'fac095f68050e9f9325269b06f261f85441209e2f5742e3fc2234115bb9fdc00'),
  t('backbeat', 'Backbeat', 'Kevin MacLeod', 'electronic', 'Electronic', 130, 46, 'Electronic_mp3/Backbeat.mp3', 1922353, '576aa0268ab27ce486f9238df3845ce104c3e05bad015ea08048ba79e88ac79a'),
  t('bit-bit-loop', 'Bit Bit Loop', 'Kevin MacLeod', 'electronic', 'Chiptune', 100, 77, 'Electronic_mp3/Bit%20Bit%20Loop.mp3', 3076298, '9316e9f2a0180411f1ee2cbb79c8d3352fef1088a9e35fd05ba0ba4c4e1f6869'),
  t('sciencenet-theme', 'Sciencenet Theme', 'Kevin MacLeod', 'electronic', 'Electronic', 110, 44, 'Miscellaneaous_mp3/Sciencenet%20Theme.mp3', 1882852, '5dd2d79311b27ece90dc52b562700053025441660a7106d55a03988ba1211ba8'),
  t('adding-the-sun', 'Adding the Sun', 'Kevin MacLeod', 'electronic', 'Electronic', 90, 176, 'Miscellaneaous_Chill_mp3/Adding%20the%20Sun.mp3', 2951782, '00180cd2ffd21eb397449e9a96081502f16e4e7c82cc9a98570e6ea7256594ed'),
  t('lukewarm-banjo', 'Lukewarm Banjo', 'Kevin MacLeod', 'acoustic', 'Country', 120, 32, 'Miscellaneaous_Country_mp3/Lukewarm%20Banjo.mp3', 1027798, '71eff3643c03be5ea36eb599214742a9cca1b127788c12f72485b7eee219a4cd'),
  t('trip-up-north', 'Trip Up North', 'Bryan Teoh', 'acoustic', 'Folk', 95, 167, 'Miscellaneaous_Country_mp3/Trip%20Up%20North.mp3', 3358764, '63236bb0ea47287aca97c98aeeeb8a0364fc83d341a50f375831a5fe31be89b1'),
  t('forest-frolic-loop', 'Forest Frolic Loop', 'Kevin MacLeod', 'acoustic', 'Folk', 104, 37, 'World_mp3/Forest%20Frolic%20Loop.mp3', 1197490, 'b69671f7e7482bc9c38bdbd57ed485f9d7f9c570635b1373e7dfa1a486e66bd3'),
  t('beat-one', 'Beat One', 'Kevin MacLeod', 'dramatic', 'Electronic', 120, 180, 'Electronic_mp3/Beat%20One.mp3', 5835821, '930dd4c6c88a2abb153f52e56a7c74bd041008f5afa4835602469dba3676aed8'),
  t('the-ice-giants', 'The Ice Giants', 'Kevin MacLeod', 'dramatic', 'Orchestral', 76, 44, 'Epic_Dramatic_mp3/The%20Ice%20Giants.mp3', 1897481, 'a421f09f685b4c31e8d68b3b976804e05a51dd2807c727db7a0d5cedeee2c6c4'),
  t('mysterious-lights', 'Mysterious Lights', 'Bryan Teoh', 'dramatic', 'Electronic', 70, 179, 'Horror_mp3/Mysterious%20Lights.mp3', 3579715, '1f0fb7f9ba9611bcdb9eef077cb0662d17e50d213e1f14ddfd1f6e6c90d1125f'),
  t('piano-magic-motive', 'Piano Magic Motive', 'Kevin MacLeod', 'sentimental', 'Piano', 101, 78, 'Romantic_Sentimental_mp3/Piano%20Magic%20Motive.mp3', 1561359, '2ccf89173ff9a8bd057d200c5b9e81728556dbb06ac5f64546c262f0e438698b'),
]);
export const musicTrack = (id: string): MusicTrack | undefined => MUSIC_LIBRARY.find((x) => x.id === id);
/** Mood words in Indonesian and English → library mood (for "musik santai", "upbeat", "tegang" …). */
const MOOD_WORDS: Record<MusicMood, RegExp> = {
  upbeat: /upbeat|ceria|happy|gembira|riang|semangat|fun/i, energetic: /energetic|energik|enerjik|cepat|action|aksi|sport/i,
  calm: /calm|tenang|santai|relax|ambient|damai|lembut/i, corporate: /corporate|korporat|bisnis|business|inspir|motivasi|presentasi/i,
  cinematic: /cinematic|sinematik|epic|epik|megah|trailer/i, dramatic: /dramatic|dramatis|tegang|tense|misteri|mystery|serius/i,
  lofi: /lo-?fi|chill|santuy|groove|funk/i, electronic: /electronic|elektronik|tech|teknologi|edm|synth/i,
  acoustic: /acoustic|akustik|gitar|guitar|folk|banjo|country/i, sentimental: /sentimental|sedih|sad|romantis|romantic|piano|haru/i,
};
/** Library tracks ranked for a free-text description (mood words first, then tempo words), stable order otherwise. */
export function rankTracks(description: string, list: readonly MusicTrack[] = MUSIC_LIBRARY): MusicTrack[] {
  const moods = MUSIC_MOODS.filter((m) => MOOD_WORDS[m].test(description));
  const fast = /cepat|fast|energik|upbeat/i.test(description), slow = /lambat|slow|tenang|calm/i.test(description);
  const score = (x: MusicTrack) => (moods.includes(x.mood) ? 10 : 0) + (fast ? x.bpm / 100 : 0) + (slow ? 100 / Math.max(40, x.bpm) : 0);
  return [...list].sort((a, b) => score(b) - score(a));
}
