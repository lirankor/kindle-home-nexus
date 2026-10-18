// Shared (client + server) media model: amp entities, the radio station catalog,
// snapshot / list / queue shapes, the action union and demo data. Contains no secrets.
import type { EntityIcon, EntityIcons } from "./icons";
import type { Lang } from "./i18n";
import { KEY_MUSIC } from "./panel-config";
import type { MediaNode, NodeType } from "./panel-config";

// ---- Amp (Yamaha R-N500) ----
/** A receiver input as its media_player lists it in `source_list` (the receiver's own title, e.g. "SERVER", "PHONO").
 *  The list itself always comes live from HA (bus task 015); the panel has no input list of its own. */
export type AmpSource = string;
export const isAmpSource = (v: unknown): v is AmpSource => typeof v === "string" && v.length > 0;
/** Inputs with a meaning for the panel's screens (Yamaha's standard titles): the DLNA / music input, the receiver's
 *  internet radio, its FM tuner and the turntable. Every other input is a plain "input". */
export const INPUT_SERVER = "SERVER";
export const INPUT_NET_RADIO = "NET RADIO";
export const INPUT_TUNER = "TUNER";
export const INPUT_PHONO = "PHONO";

const MEDIA_PLUG = "smart_switch_23081678814571510d0548e1e9d69992";
/** Amp / TV / movie entities (panel config: media). Mutated in place by applyMediaConfig. */
export const AMP = {
  player: "media_player.r_n500_main",
  volumeDb: "number.r_n500_main_volume_db",
  dlna: "media_player.yamaha_r_n500",
  plug: `switch.${MEDIA_PLUG}_outlet`,
  plugPower: `sensor.${MEDIA_PLUG}_power`,
  tv: "media_player.bravia_xr_65x90k",
  movieActive: "script.movie_mode",
  movieOn: "script.movie_mode",
  movieOff: "script.movie_mode_off",
  /** HA config entry of the yamaha_ynca integration; reloading it reconnects right after power-on. */
  yncaEntryId: "01M0ZMQXMTWAAW7BXTBCXD1YZR",
  volumeMinDb: -80.5,
  volumeMaxDb: 16.5,
  /** One 5-way press: 1 dB, the receiver bridge's own volume_step_db (bus task 022; it was 2). */
  volumeStepDb: 1,
};
/** Media tab nodes and F1..F4 (panel config: media.nodes / media.keys). Rewritten in place by applyMediaConfig. */
export const MEDIA_NODES: MediaNode[] = [];
export const MEDIA_KEYS: string[] = [KEY_MUSIC, "none", "none", "none"];
export const OUTPUT_KEYS: string[] = ["none", "none", "none", "none"];
/** The legacy amp machinery (power-on routine, snapshot amp/tv, all off) runs on the first receiver and the first TV
 *  node; every node's own controls go through its node id (media-nodes.server.ts). */
export function applyMediaConfig(m: {
  nodes?: MediaNode[];
  keys?: string[];
  output_keys?: string[];
}) {
  const nodes = m.nodes ?? [];
  MEDIA_NODES.splice(0, MEDIA_NODES.length, ...nodes);
  MEDIA_KEYS.splice(0, MEDIA_KEYS.length, ...(m.keys ?? [KEY_MUSIC, "none", "none", "none"]));
  OUTPUT_KEYS.splice(0, OUTPUT_KEYS.length, ...(m.output_keys ?? ["none", "none", "none", "none"]));
  const amp = nodes.find((n) => n.type === "receiver");
  const tv = nodes.find((n) => n.type === "tv");
  AMP.player = amp?.power_device ?? "";
  AMP.volumeDb = amp?.volume ?? "";
  AMP.dlna = amp?.dlna_player ?? "";
  AMP.plug = amp?.plug ?? "";
  AMP.plugPower = amp?.plug_power ?? "";
  AMP.yncaEntryId = amp?.ynca_entry_id ?? "";
  AMP.tv = tv?.entity ?? "";
  AMP.movieOn = tv?.movie_on ?? "";
  AMP.movieOff = tv?.movie_off ?? "";
  AMP.movieActive = tv?.movie_active ?? "";
}

// ---- Radio stations (from Home Assistant: the receiver bridge's NET RADIO station select, bus task 016) ----
// The station list is owned by the yamaha_netbridge config entry in HA (its options); the bridge's
// `select.<receiver>_net_radio_station` publishes it as the `stations` attribute in list order. The panel never ships
// or reads a station file. Bands = the list's groups in first-appearance order (= the receiver's menu order).
export type RadioStation = {
  id: string;
  name: string;
  /** Not published by the bridge (stream URLs stay in HA); kept for the app backend's YTuner matching. */
  url: string;
  codec: string;
  bitrate: number;
  /** FM frequency in MHz when the list has one, else null. */
  fm: number | null;
  logo: string | null;
};
export type RadioList = {
  id: string;
  /** The group name (a folder in the receiver's NET RADIO menu; YTuner "My Stations" category). */
  ytunerCategory: string;
  stations: RadioStation[];
};
/** One entry of the bridge select's `stations` attribute. */
export type BridgeStation = {
  id: string;
  name: string;
  group: string;
  fm_mhz?: number | null;
  logo?: string | null;
};

const cleanLogo = (logo: unknown): string | null =>
  typeof logo === "string" && /^https?:\/\//.test(logo) ? logo : null;
const bandId = (group: string) =>
  group
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "band";

/** Bridge stations -> bands (groups in first-appearance order). Pure; unit tested. */
export function radioListsFromBridge(stations: unknown): RadioList[] {
  if (!Array.isArray(stations)) return [];
  const lists: RadioList[] = [];
  for (const raw of stations as Partial<BridgeStation>[]) {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.group !== "string"
    )
      continue;
    let list = lists.find((l) => l.ytunerCategory === raw.group);
    if (!list) {
      let id = bandId(raw.group);
      while (id === FAVOURITES_LIST_ID || lists.some((l) => l.id === id)) id += "-2";
      list = { id, ytunerCategory: raw.group, stations: [] };
      lists.push(list);
    }
    list.stations.push({
      id: raw.id,
      name: raw.name,
      url: "",
      codec: "",
      bitrate: 0,
      fm: typeof raw.fm_mhz === "number" ? raw.fm_mhz : null,
      logo: cleanLogo(raw.logo),
    });
  }
  return lists;
}

/** The current bands; rewritten in place by setRadioLists (server: from HA every 30 s, tests: a fixture). */
export const RADIO_LISTS: RadioList[] = [];
export function setRadioLists(lists: RadioList[]) {
  RADIO_LISTS.splice(0, RADIO_LISTS.length, ...lists);
}
/** The YTuner bookmark list (app backend only), shown as the "favourites" band. The HA backend's dial has no favourites
 *  band (bus task 025: the dial is the amp's NET RADIO; Music Assistant favourites are not the amp's). */
export const FAVOURITES_LIST_ID = "favourites";
export const radioListIds = () => [FAVOURITES_LIST_ID, ...RADIO_LISTS.map((l) => l.id)];
/** Music Assistant radios the bridge's list does not have (HA backend, bus task 024): id `ma:<slug>`, the logo MA
 *  reports, for the music screen's station picture only (never a dial station, bus task 025). Filled server side from
 *  what MA plays, never from the page. */
const MA_STATIONS = new Map<string, RadioStation>();
export function rememberMaStation(id: string, name: string, logo: unknown) {
  if (!id.startsWith("ma:")) return;
  MA_STATIONS.set(id, {
    id,
    name,
    url: "",
    codec: "",
    bitrate: 0,
    fm: null,
    logo: cleanLogo(logo),
  });
}
export const findStation = (id: string): RadioStation | undefined =>
  RADIO_LISTS.flatMap((l) => l.stations).find((s) => s.id === id) ?? MA_STATIONS.get(id);
/** Hosts the image route may fetch logos from (besides the configured servers). */
export const catalogLogoHosts = () =>
  Array.from(
    new Set(
      [...RADIO_LISTS.flatMap((l) => l.stations), ...MA_STATIONS.values()]
        .map((s) => s.logo)
        .filter((u): u is string => u !== null)
        .flatMap((u) => {
          try {
            return [new URL(u).hostname];
          } catch {
            return [];
          }
        }),
    ),
  );

export type RadioStationView = RadioStation & {
  /** YTuner StationId (MS_…) when YTuner knows the stream URL, else null. */
  ytunerId: string | null;
  favourite: boolean;
};
/** `name`: the group's name (the band label when the panel has no translation for its id). */
export type RadioListView = { id: string; name?: string; stations: RadioStationView[] };
/** Where the amp's NET RADIO cursor was left by us (list id + 0-based station index). */
export type RadioPosition = { list: string; index: number };
export type RadioListsResult = {
  configured: boolean;
  error?: string;
  lists: RadioListView[];
  current: RadioPosition | null;
};

// ---- Now playing / snapshot ----
export type AmpStatus = {
  /** HA knows the entity (not unavailable). */
  available: boolean;
  on: boolean;
  /** HA state: off, on, idle, playing, paused, unavailable. */
  state: string;
  /** The renderer reports playing: HA's media_player or the DLNA renderer says `playing` (not the
   *  app's queue belief). Informational (voice API); analogue inputs never report it. */
  playing: boolean;
  source: AmpSource | null;
  volumeDb: number | null;
  /** 0..1 */
  volume: number | null;
  muted: boolean;
};
/** "input": any other receiver input (CD, LINE1, OPTICAL, …): its name is all the panel can show. */
export type NowPlayingKind = "radio" | "music" | "fm" | "input" | "phono" | "none";
export type NowPlaying = {
  kind: NowPlayingKind;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** NET RADIO station or FM channel text. */
  station: string | null;
  /** Jellyfin item id to fetch art for via /media/img?item=… */
  artItemId: string | null;
  /** Catalog station id when the playing station is one of ours. */
  stationId: string | null;
  preset: number | null;
};
export type PowerOnStep = "plug" | "wait" | "reload" | "turn_on" | "source" | "done" | "failed";
export type PowerOnStatus = {
  running: boolean;
  step: PowerOnStep;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  source: AmpSource | null;
  error?: string;
};
/** One Media tab row / node screen: the node's live state, read generically from HA (media-nodes.ts). */
export type NodeView = {
  id: string;
  type: NodeType;
  name: string;
  available: boolean;
  on: boolean;
  /** HA state of the node's media_player. */
  state: string;
  source: string | null;
  /** The entity's source_list in its own order, without the inputs hidden in the node's `inputs` rows. */
  sources: string[];
  /** Inputs renamed in the node's `inputs` rows (absent: the device's own title). */
  inputNames?: Record<string, InputName>;
  /** Input icons from the node's `inputs` rows (icon pack names, bus task 019; absent: the input's own glyph). */
  inputIcons?: Record<string, string>;
  /** The node's icon pack name (absent: its entity's HA icon, else by type, receiver "speaker", tv "tv"). */
  icon?: string;
  /** The node entity's own HA icon, resolved on the server (bus task 020). */
  entityIcon?: EntityIcon;
  volumeDb: number | null;
  /** 0..1 */
  volume: number | null;
  muted: boolean;
  /** receiver: the stream select's option and options (dlna / airplay). */
  stream: string | null;
  streams: string[];
  /** receiver with a NET RADIO station select (yamaha_netbridge >= 0.3.0): its stations in list order, the one
   *  playing (select option) and the receiver's own now-playing text for NET RADIO. */
  stations?: NodeStation[];
  station?: string | null;
  nowTitle?: string | null;
  nowArtist?: string | null;
  /** tv: movie mode configured / on. */
  movie: boolean;
  movieActive: boolean;
};
export type InputName = { name?: string; name_he?: string };
/** One NET RADIO station of a receiver node: `option` is what select.select_option takes ("Group · Station"). */
export type NodeStation = { option: string; name: string; group: string; fm: number | null };
/** The music output (MUSIC_BACKEND=ha): what the panel plays to, and what the picker offers. */
export type OutputView = {
  /** The chosen MA player; null = none chosen yet. */
  entity: string | null;
  name: string | null;
  /** The chosen one still exists in HA (else the picker opens by itself). */
  valid: boolean;
  outputs: OutputRow[];
  /** MA players HA has no entity for (MA's "Expose to Home Assistant" is off): listed, not selectable. */
  unexposed?: OutputRow[];
  /** Picker F1..F4: an MA player or "none". */
  keys: string[];
  /** A move (Music Assistant transfer_queue) to `entity` is under way: "moving…" until it plays (bus task 021). */
  moving?: { entity: string; name: string; startedAt: number; failed?: string | null } | null;
  /** Another output plays while the chosen one does not: the music screen's hint line. */
  playingElsewhere?: { entity: string; name: string; now: string | null } | null;
  /** A move HA refused or undid (bus task 022): the output stayed; the music screen shows why for a minute. */
  moveError?: { name: string; error: string; at: number } | null;
  /** The output leads a sync group: its name with its members ("R-N500 AirPlay + TV"); else absent. */
  groupName?: string | null;
  /** The picker greys unavailable rows instead of hiding them (panel option show_unavailable_outputs). */
  showUnavailable?: boolean;
};
/** One row of the output picker: an MA player or MA group, its live state and what it plays. */
export type OutputRow = {
  entity_id: string;
  name: string;
  state: string;
  /** "Title · Artist" while it has something. */
  now?: string | null;
  /** What it plays, by part (from HA's live state), so the picker's one status line can drop the album first, then
   *  the artist (bus task 023). */
  nowParts?: NowParts | null;
  kind?: "player" | "group";
  /** false: an MA player without an HA entity (cannot be chosen until MA exposes it). */
  exposed?: boolean;
  /** Sync (bus task 022, from MA's can_group_with): the players this one can play in sync with. */
  groupWith?: string[];
  /** It leads a sync group: the members, itself first. */
  groupMembers?: string[];
  /** It follows a sync group: the leader. */
  syncedTo?: string | null;
};
export type NowParts = { title: string | null; artist: string | null; album: string | null };
/** Characters that fit on a picker row's status line (600 px panel, 20 px font, icon + check mark beside it). */
export const OUTPUT_STATUS_CHARS = 40;
/** A picker row's one status line (bus task 023): "now-playing · state…", trimmed to `max` characters by dropping
 *  the album first, then the artist, then cutting the title with "…". The `tail` (state, group / sync labels) is
 *  never dropped; CSS still ellipsizes the line if a wide font needs it. */
export function fitStatusLine(
  parts: NowParts | null | undefined,
  tail: (string | null | undefined)[],
  max = OUTPUT_STATUS_CHARS,
): string {
  const rest = tail.filter((x): x is string => !!x).join(" · ");
  const join = (xs: (string | null | undefined)[]) =>
    [...xs.filter((x): x is string => !!x), ...(rest ? [rest] : [])].join(" · ");
  if (!parts?.title) return join([parts?.artist ?? null]).slice(0, Math.max(max, rest.length));
  for (const xs of [
    [parts.title, parts.artist, parts.album],
    [parts.title, parts.artist],
    [parts.title],
  ]) {
    const line = join(xs);
    if (line.length <= max) return line;
  }
  const room = max - (rest ? rest.length + 3 : 0) - 1;
  if (room < 4) return join([parts.title]); // the state alone fills the line: CSS ellipsizes the title
  // first-strong isolate: in a Hebrew line the "…" stays at the end of a Latin title (not before it)
  return join([`\u2068${parts.title.slice(0, room).trimEnd()}…\u2069`]);
}

/** The sync leader the panel's output belongs to: the output itself, or the group it follows. */
export const syncLeaderOf = (rows: OutputRow[], entity: string | null): OutputRow | undefined => {
  const cur = rows.find((r) => r.entity_id === entity);
  return cur?.syncedTo ? (rows.find((r) => r.entity_id === cur.syncedTo) ?? cur) : cur;
};

/** What the picker's sync key does on a row (bus task 022): join it to the output's group, take it out, or nothing
 *  (it cannot sync with this output, or it is the leader itself). */
export function syncActionFor(
  rows: OutputRow[],
  entity: string | null,
  row: OutputRow | undefined,
): "join" | "unjoin" | null {
  const leader = syncLeaderOf(rows, entity);
  if (!leader || !row || row.exposed === false || row.entity_id === leader.entity_id) return null;
  if (row.syncedTo === leader.entity_id) return "unjoin";
  if ((leader.groupWith ?? []).includes(row.entity_id) && row.state !== "unavailable")
    return "join";
  return null;
}

export type MediaSnapshot = {
  /** Media tab rows (bus task 014); absent in old snapshots. */
  nodes?: NodeView[];
  /** Media tab F1..F4: "music", a node id, a script, "all_off" or "none". */
  keys?: string[];
  /** HA music backend only. */
  output?: OutputView | null;
  /** Labels of script keys (their HA friendly names). */
  keyLabels?: Record<string, string>;
  /** HA icons of the entity keys (scripts, MA players) and the output picker's rows (bus task 020). */
  icons?: EntityIcons;
  amp: AmpStatus;
  nowPlaying: NowPlaying;
  tv: { state: string; source: string | null };
  plugOn: boolean;
  movieActive: boolean;
  queue: QueueProgress | null;
  radio: RadioPosition | null;
  powerOn: PowerOnStatus | null;
};
export type MediaSnapshotResult = {
  /** HA token present. */
  configured: boolean;
  /** AMP_HOST present (XML / UPnP features). */
  amp: boolean;
  /** Jellyfin url + key present. */
  jellyfin: boolean;
  error?: string;
  snapshot: MediaSnapshot | null;
  lang: Lang;
};

// ---- Jellyfin ----
export type MusicTrack = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumId: string | null;
  durationMs: number;
  /** Jellyfin container: mp3, flac, ogg, opus, asf, … */
  container: string | null;
  artItemId: string | null;
};
export type MusicItemKind = "album" | "artist" | "track" | "mix";
export type MusicListItem = {
  kind: MusicItemKind;
  id: string;
  title: string;
  detail: string;
  artItemId: string | null;
  /** Album rows on the artist screen: year, release date (yyyy-mm-dd, often just "yyyy-01-01" when
   *  the tags only knew the year), number of tracks and the first genre, when known. */
  year?: number | null;
  releaseDate?: string | null;
  trackCount?: number | null;
  genre?: string | null;
};
export const MUSIC_TABS = ["mixes", "suggested", "artists", "albums", "recent"] as const;
export type MusicTab = (typeof MUSIC_TABS)[number];
export const MUSIC_PAGE_SIZE = 8;
export type MusicListResult = {
  configured: boolean;
  error?: string;
  tab: MusicTab;
  page: number;
  pages: number;
  items: MusicListItem[];
};
export type PlaySelection = { kind: MusicItemKind; id: string };
/** Search screen (F4 on the music screen): artists and albums whose names start with the typed words.
 *  Results appear from the second character; the list holds one screen, no paging. */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_RESULT_ROWS = 5;
export const SEARCH_MAX_CHARS = 40;
export type MusicSearchResult = {
  configured: boolean;
  error?: string;
  query: string;
  items: MusicListItem[];
};
/** Artist screen (Enter on an artist in the lists or the search): their albums, oldest first. */
export type ArtistAlbumsResult = {
  configured: boolean;
  error?: string;
  artist: { id: string; title: string; artItemId: string | null };
  page: number;
  pages: number;
  total: number;
  items: MusicListItem[];
};
export const MIX_IDS = [
  "daily",
  "discover",
  "party",
  "dancing",
  "rock",
  "pop",
  "s60",
  "s70",
  "s80",
  "s90",
  "s2000",
  "relaxed",
  "evening",
  "jazz",
  "blues",
  "punk",
  "metal",
  "electronic",
  "classical",
] as const;
export type MixId = (typeof MIX_IDS)[number];

// ---- Playback queue (server-owned; the browser only ever sees QueueProgress) ----
export type QueueTrack = MusicTrack & { streamUrl: string };
export type QueueStatus = "playing" | "paused" | "stopped" | "ended";
export type QueueState = {
  id: string;
  title: string;
  tracks: QueueTrack[];
  index: number;
  status: QueueStatus;
  /** Wall clock (ms) when the current track started counting from offsetMs; null unless playing. */
  startedAt: number | null;
  /** Position inside the current track at startedAt (after a seek / resume). */
  offsetMs: number;
  /** SetNextAVTransportURI already sent for index + 1. */
  nextPushed: boolean;
  /** Why the server paused the queue itself ("renderer stopped", an amp error); null otherwise. */
  stall?: string | null;
};
/** The whole queue for the playlist screen (stream URLs stripped). */
export type QueueList = { title: string; index: number; status: QueueStatus; tracks: MusicTrack[] };
export type QueueProgress = {
  title: string;
  index: number;
  count: number;
  track: MusicTrack | null;
  positionMs: number;
  durationMs: number;
  status: QueueStatus;
  /** Neighbours of the current track, so a skip can be drawn before the server answers (the Kindle
   *  only re-fetches its screen on a key press or every 20 s). Up to 3 upcoming, 1 previous. */
  prevTrack?: MusicTrack | null;
  nextTracks?: MusicTrack[];
  /** Set when the server paused the queue itself (renderer stall watchdog / amp error). */
  stall?: string | null;
};

// ---- Actions ----
export type MediaAction =
  | { type: "amp.power"; on: boolean }
  | { type: "amp.source"; source: AmpSource }
  | { type: "amp.volume.step"; delta: 1 | -1 }
  | { type: "amp.volume.db"; db: number }
  | { type: "amp.volume.set"; level: number }
  | { type: "amp.reload" }
  | { type: "plug"; on: boolean }
  | { type: "tv"; op: "turn_on" | "turn_off" | "toggle" | "volume_mute" }
  | { type: "movie"; on: boolean }
  | { type: "fm.preset"; preset: number }
  | { type: "fm.frequency"; mhz: number }
  | { type: "radio.step"; delta: 1 | -1 }
  | { type: "radio.favourite"; stationId: string; add: boolean }
  /** NET RADIO stream stop / play (Enter on the radio screen). */
  | { type: "radio.playback"; op: "play" | "stop" }
  | { type: "queue"; op: "next" | "prev" | "pause" | "resume" | "toggle" | "stop" }
  /** Playlist screen: play track `index` of the queue. */
  | { type: "queue.jump"; index: number }
  /** TV off, amp to standby, then (3 s later) the media plug off. */
  | { type: "all_off" }
  /** A node's own controls (Media tab node screens). */
  | { type: "node"; id: string; op: "power"; on: boolean }
  | { type: "node"; id: string; op: "volume"; delta: 1 | -1 }
  | { type: "node"; id: string; op: "source"; source: string }
  | { type: "node"; id: string; op: "stream"; option: string }
  | { type: "node"; id: string; op: "station"; option: string }
  | { type: "node"; id: string; op: "movie"; on: boolean }
  /** A Media tab key mapped to a script. */
  | { type: "script"; entity: string }
  /** The output picker chose this Music Assistant player. */
  | { type: "output"; entity: string }
  /** Move the music (MA transfer_queue) from the panel's output to `entity`, which becomes the output. */
  | { type: "output.move"; entity: string }
  /** Sync `entity` with the panel's output (HA media_player.join, leader = the output) or take it out (unjoin). */
  | { type: "output.sync"; entity: string; join: boolean };
export type MediaActionResult = { ok: boolean; error?: string; snapshot?: MediaSnapshot | null };

// ---- Demo data (no env) ----
export const demoTracks = (): MusicTrack[] =>
  [
    ["Where Is Love", "McCoy Tyner Trio", "Infinity", 332000],
    ["New Born", "Muse", "Origin of Symmetry", 365000],
    ["Come Sail Away", "Styx", "Greatest Hits", 364000],
    ["So What", "Miles Davis", "Kind of Blue", 562000],
  ].map(([title, artist, album, durationMs], i) => ({
    id: `demo-${i + 1}`,
    title: String(title),
    artist: String(artist),
    album: String(album),
    albumId: `demo-album-${i + 1}`,
    durationMs: Number(durationMs),
    container: "mp3",
    artItemId: null,
  }));

export function demoMediaSnapshot(): MediaSnapshot {
  const station = RADIO_LISTS[0]?.stations[0];
  return {
    amp: {
      available: true,
      on: true,
      state: "playing",
      playing: true,
      source: "NET RADIO",
      volumeDb: -44.5,
      volume: 0.37,
      muted: false,
    },
    nowPlaying: {
      kind: "radio",
      title: "Zara Larsson - Memory Lane",
      artist: null,
      album: null,
      station: station?.name ?? "1LIVE",
      artItemId: null,
      stationId: station?.id ?? null,
      preset: null,
    },
    tv: { state: "off", source: null },
    plugOn: true,
    movieActive: false,
    queue: null,
    radio: station ? { list: RADIO_LISTS[0]?.id ?? "local", index: 0 } : null,
    powerOn: null,
    nodes: [
      {
        id: "amp",
        type: "receiver",
        name: "Yamaha R-N500",
        available: true,
        on: true,
        state: "playing",
        source: "NET RADIO",
        // what yamaha_netbridge reports for an R-N500 (demo data stands in for HA's source_list)
        sources: ["Spotify", "NET RADIO", "SERVER", "AirPlay", "TUNER", "PHONO", "CD", "LINE1"],
        inputNames: { CD: { name: "Bluetooth & TV", name_he: "בלוטות׳ וטלוויזיה" } },
        volumeDb: -44.5,
        volume: 0.37,
        muted: false,
        stream: "dlna",
        streams: ["dlna", "airplay"],
        movie: false,
        movieActive: false,
      },
      {
        id: "tv",
        type: "tv",
        name: "Sony TV",
        available: true,
        on: false,
        state: "off",
        source: null,
        sources: ["HDMI 1", "HDMI 2", "Netflix"],
        volumeDb: null,
        volume: null,
        muted: false,
        stream: null,
        streams: [],
        movie: true,
        movieActive: false,
      },
    ],
    keys: [KEY_MUSIC, "amp", "tv", "none"],
    output: null,
  };
}

export function demoRadioLists(): RadioListsResult {
  return {
    configured: false,
    lists: [
      { id: FAVOURITES_LIST_ID, stations: [] },
      ...RADIO_LISTS.map((l) => ({
        id: l.id,
        name: l.ytunerCategory,
        stations: l.stations.map((s) => ({ ...s, ytunerId: null, favourite: false })),
      })),
    ],
    current: { list: RADIO_LISTS[0]?.id ?? "local", index: 0 },
  };
}

/** Demo mode: Enter on a list item "plays" the demo tracks from the first one, without a server. */
export function demoQueue(title: string): QueueProgress {
  const tracks = demoTracks();
  const track = tracks[0]!;
  return {
    title,
    index: 0,
    count: tracks.length,
    track,
    positionMs: 0,
    durationMs: track.durationMs,
    status: "playing",
    prevTrack: null,
    nextTracks: tracks.slice(1, 4),
  };
}

export function demoMusicList(tab: MusicTab, page: number): MusicListResult {
  const tracks = demoTracks();
  const items: MusicListItem[] =
    tab === "mixes"
      ? MIX_IDS.map((id) => ({ kind: "mix", id, title: id, detail: "20", artItemId: null }))
      : tab === "artists"
        ? tracks.map((t) => ({
            kind: "artist",
            id: `artist-${t.id}`,
            title: t.artist ?? "",
            detail: "3",
            artItemId: null,
          }))
        : tab === "suggested"
          ? tracks.map((t) => ({
              kind: "track",
              id: t.id,
              title: t.title,
              detail: t.artist ?? "",
              artItemId: null,
            }))
          : tracks.map((t) => ({
              kind: "album",
              id: t.albumId ?? t.id,
              title: t.album ?? "",
              detail: t.artist ?? "",
              artItemId: null,
            }));
  return { configured: false, tab, page: 0, pages: 1, items: page === 0 ? items : [] };
}

/** Demo artist screen: the demo albums of that demo artist (`artist-<track id>`). */
export function demoArtistAlbums(artistId: string, page: number): ArtistAlbumsResult {
  const tracks = demoTracks();
  const seed = tracks.find((t) => `artist-${t.id}` === artistId);
  const name = seed?.artist ?? "";
  const seen = new Set<string>();
  const items: MusicListItem[] = tracks
    .filter(
      (t) =>
        t.artist === name && t.album && !seen.has(t.albumId ?? t.id) && seen.add(t.albumId ?? t.id),
    )
    .map((t) => ({
      kind: "album",
      id: t.albumId ?? t.id,
      title: t.album ?? "",
      detail: "",
      artItemId: null,
      year: 1999,
      releaseDate: "1999-04-17",
      trackCount: 4,
      genre: "Jazz",
    }));
  return {
    configured: false,
    artist: { id: artistId, title: name, artItemId: null },
    page: 0,
    pages: 1,
    total: items.length,
    items: page === 0 ? items : [],
  };
}

/** Demo search: the demo artists and albums whose name contains the query (artists first). */
export function demoMusicSearch(query: string): MusicSearchResult {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const items = [...demoMusicList("artists", 0).items, ...demoMusicList("albums", 0).items].filter(
    (item) => {
      if (!q || seen.has(item.id) || !item.title.toLowerCase().includes(q)) return false;
      seen.add(item.id);
      return true;
    },
  );
  return { configured: false, query, items: items.slice(0, SEARCH_RESULT_ROWS) };
}
