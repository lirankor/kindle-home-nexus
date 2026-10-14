// Pure helpers of the voice bridge (src/routes/api/voice.$.ts): spoken-query matching against the library,
// mix aliases, fuzzy radio-station lookup and the compact queue summary. No I/O, no secrets; unit-tested in
// voice-api.test.ts. Nothing in the Kindle screens imports this.
import { FAVOURITES_LIST_ID, MIX_IDS, RADIO_LISTS } from "@/lib/media";
import type { MusicItemKind, MusicTrack, QueueProgress } from "@/lib/media";

/** Lower-case, strip accents, a leading article and punctuation: "The Eagles!" -> "eagles". */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an|der|die|das) /, "");
/**
 * How well a catalog name answers a spoken query (0..100): exact 100, name starts with the query 80,
 * query starts with the name 70 ("eagles hotel california" vs artist "Eagles"), query is a whole word
 * inside the name 60, every query word occurs in the name 50, otherwise the share of shared words * 30.
 */
export function matchScore(name: string, query: string): number {
  const n = norm(name);
  const q = norm(query);
  if (!n || !q) return 0;
  if (n === q) return 100;
  if (n.startsWith(`${q} `)) return 80;
  if (q.startsWith(`${n} `)) return 70;
  if (` ${n} `.includes(` ${q} `)) return 60;
  const nw = new Set(n.split(" "));
  const qw = q.split(" ");
  const shared = qw.filter((w) => nw.has(w)).length;
  if (shared === qw.length) return 50;
  return Math.round((shared / qw.length) * 30);
}
/** Spoken filler a wildcard sentence may leave in the query ("put on something by the beatles"). */
export const stripFiller = (q: string) =>
  q
    .trim()
    .replace(
      /^((some|something (by|from|of)|anything (by|from)|music (by|from|of)|songs? (by|from|of)|a (song|track) (by|from)|the (band|artist|album|song|group|playlist|mix)|album|artist|playlist) )+/i,
      "",
    )
    .replace(/^((משהו של|שירים של|מוזיקה של|את האלבום|את השיר|את|האלבום|השיר|שיר של) )+/, "")
    .trim();
export type VoiceKind = MusicItemKind | "playlist";
export type Candidate = {
  kind: VoiceKind;
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  score: number;
};
/** Kind preference on equal scores: an artist beats an album beats a playlist beats a track. */
const KIND_BONUS: Record<VoiceKind, number> = {
  artist: 3,
  album: 2,
  mix: 2,
  playlist: 1,
  track: 0,
};
/** Best candidate, or null when nothing scores at least `min` (shorter names win ties). */
export function pickBest(cands: Candidate[], min = 30): Candidate | null {
  const best = [...cands]
    .filter((c) => c.score >= min)
    .sort(
      (a, b) =>
        b.score + KIND_BONUS[b.kind] - (a.score + KIND_BONUS[a.kind]) ||
        a.title.length - b.title.length,
    )[0];
  return best ?? null;
}
/** Spoken mix names -> MIX_IDS ("80s", "the eighties", "party mix", "jazz"). */
const MIX_ALIASES: Record<string, (typeof MIX_IDS)[number]> = {
  "60s": "s60",
  "1960s": "s60",
  sixties: "s60",
  "70s": "s70",
  "1970s": "s70",
  seventies: "s70",
  "80s": "s80",
  "1980s": "s80",
  eighties: "s80",
  "90s": "s90",
  "1990s": "s90",
  nineties: "s90",
  "2000s": "s2000",
  noughties: "s2000",
  dance: "dancing",
  chill: "relaxed",
  relax: "relaxed",
  calm: "relaxed",
  night: "evening",
  "heavy metal": "metal",
  electro: "electronic",
  classic: "classical",
  "daily mix": "daily",
  "my mix": "daily",
  new: "discover",
};
export function mixFor(query: string): (typeof MIX_IDS)[number] | null {
  const q = norm(query).replace(/ ?(mix|music|playlist)$/, "");
  const direct = MIX_IDS.find((id) => id === q);
  if (direct) return direct;
  return MIX_ALIASES[q] ?? null;
}
/** Hebrew / spoken aliases for catalog stations (matched next to the English catalog names). */
const STATION_ALIASES: Record<string, string[]> = {
  Galgalatz: ["גלגלצ", "גל גלץ", "גלגל"],
  "Kol Barama": ["קול ברמה"],
  "Kol Chai": ["קול חי"],
  "Kan Bet": ["כאן ב", "כאן בית", "רשת ב", "kan b"],
  "Galei Zahal": ["גלי צהל", "גלצ", "galatz"],
  "Radio Darom": ["רדיו דרום"],
  "Kan Gimel": ["כאן גימל", "כאן ג", "רשת ג", "kan g"],
  "Eco 99": ["אקו 99", "אקו", "eco"],
  "Radios 100FM": ["רדיוס", "רדיוס 100", "100 אף אם"],
  "Radio Tel Aviv 102": ["רדיו תל אביב", "תל אביב 102", "102"],
  "Galey Yisrael": ["גלי ישראל"],
  "103FM": ["103 אף אם", "רדיו 103", "103"],
  "Kol Hashfela": ["קול השפלה"],
  "Kan Tarbut": ["כאן תרבות"],
  "Radio Haifa": ["רדיו חיפה"],
  "Kan Kol HaMusica": ["כאן קול המוסיקה", "קול המוזיקה", "קול המוסיקה"],
  "Radio Lev Hamedina": ["רדיו לב המדינה", "לב המדינה"],
  Hakatze: ["הקצה"],
  "100FM Oldies": ["אולדיז", "100 אף אם אולדיז"],
  "100FM 80s": ["100 אף אם שנות ה-80", "שנות השמונים ברדיו"],
  "100FM Movies": ["100 אף אם סרטים"],
  "BBC World Service": ["bbc", "בי בי סי"],
  Deutschlandfunk: ["dlf"],
  "Deutschlandfunk Kultur": ["dlf kultur"],
  "1LIVE": ["einslive", "eins live"],
};
export type StationHit = { list: string; index: number; name: string; score: number };
/** Fuzzy station lookup over the catalog (favourites are YTuner bookmarks and are not matched by name). */
export function matchStation(query: string, min = 50): StationHit | null {
  const q = norm(query).replace(/^(radio|station|רדיו|תחנת|תחנה) /, "");
  let best: StationHit | null = null;
  for (const list of RADIO_LISTS)
    list.stations.forEach((s, index) => {
      const names = [
        s.name,
        s.id.replace(/-/g, " "),
        ...(STATION_ALIASES[s.name] ?? []),
        ...(s.fm ? [`${s.fm}`, `${s.fm} fm`] : []),
      ];
      const score = Math.max(...names.map((n) => Math.max(matchScore(n, q), matchScore(n, query))));
      if (score >= min && (!best || score > best.score))
        best = { list: list.id, index, name: s.name, score };
    });
  return best;
}

// ---- Shapes ----
export const trackView = (t: MusicTrack | null | undefined) =>
  t
    ? {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationMs: t.durationMs,
        // Jellyfin ids for colour art (HA's Music dashboard: /Items/<albumId ?? artItemId>/Images/Primary)
        albumId: t.albumId ?? null,
        artItemId: t.artItemId ?? null,
      }
    : null;
export const queueSummary = (q: QueueProgress | null | undefined) =>
  q
    ? {
        title: q.title,
        status: q.status,
        index: q.index,
        count: q.count,
        positionMs: q.positionMs,
        durationMs: q.durationMs,
        track: trackView(q.track),
        next: (q.nextTracks ?? []).slice(0, 3).map(trackView),
      }
    : null;
export const stationName = (p: { list: string; index: number } | null) =>
  p && p.list !== FAVOURITES_LIST_ID
    ? (RADIO_LISTS.find((l) => l.id === p.list)?.stations[p.index]?.name ?? null)
    : null;
