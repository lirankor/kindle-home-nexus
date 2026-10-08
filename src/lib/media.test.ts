import { describe, expect, it } from "vitest";
import {
  buildDidl,
  decideAdvance,
  formatHms,
  parseBasicStatus,
  parseHms,
  parseListInfo,
  parseNetRadioPlayInfo,
  parsePositionInfo,
  parseTunerPlayInfo,
  parseYtunerStations,
  pickStreamUrl,
  queueAdvance,
  queueDue,
  queueProgress,
  rewriteToBase,
  soapEnvelope,
  trackIdFromUri,
  xmlEscape,
  xmlUnescape,
} from "./media-protocol";
import { CATALOG_LOGO_HOSTS, FAVOURITES_LIST_ID, RADIO_LISTS, demoMusicList } from "./media";
import type { QueueState, QueueTrack } from "./media";
import { buildMediaSnapshot, imageHostAllowed } from "./media.server";
import type { HaState } from "./home.server";

// Real responses captured from the R-N500 on 2026-10-08.
const LIST_INFO =
  '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><List_Info><Menu_Status>Ready</Menu_Status><Menu_Layer>3</Menu_Layer><Menu_Name>Duesseldorf FM</Menu_Name><Current_List><Line_1><Txt>1LIVE</Txt><Attribute>Item</Attribute></Line_1><Line_2><Txt>WDR 2</Txt><Attribute>Item</Attribute></Line_2><Line_3><Txt>WDR 3</Txt><Attribute>Item</Attribute></Line_3><Line_4><Txt>WDR 4</Txt><Attribute>Item</Attribute></Line_4><Line_5><Txt>WDR 5</Txt><Attribute>Item</Attribute></Line_5><Line_6><Txt>COSMO</Txt><Attribute>Item</Attribute></Line_6><Line_7><Txt>Antenne Duesseldorf</Txt><Attribute>Item</Attribute></Line_7><Line_8><Txt>NRW1</Txt><Attribute>Item</Attribute></Line_8></Current_List><Cursor_Position><Current_Line>5</Current_Line><Max_Line>12</Max_Line></Cursor_Position></List_Info></NET_RADIO></YAMAHA_AV>';
const PLAY_INFO =
  '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><Play_Info><Feature_Availability>Ready</Feature_Availability><Playback_Info>Play</Playback_Info><Meta_Info><Station>1LIVE</Station><Album></Album><Song>Zara Larsson - Memory Lane</Song></Meta_Info><Album_ART><URL></URL><ID>0</ID><Format></Format></Album_ART></Play_Info></NET_RADIO></YAMAHA_AV>';
const BASIC_STATUS =
  '<YAMAHA_AV rsp="GET" RC="0"><Main_Zone><Basic_Status><Power_Control><Power>On</Power><Sleep>Off</Sleep></Power_Control><Volume><Lvl><Val>-350</Val><Exp>1</Exp><Unit>dB</Unit></Lvl><Mute>Off</Mute></Volume><Input><Input_Sel>NET RADIO</Input_Sel><Input_Sel_Item_Info><Param>NET RADIO</Param><RW>RW</RW><Title></Title><Icon><On>/YamahaRemoteControl/Icons/icon067.png</On><Off></Off></Icon><Src_Name></Src_Name><Src_Number>1</Src_Number></Input_Sel_Item_Info></Input></Basic_Status></Main_Zone></YAMAHA_AV>';
const TUNER_INFO =
  '<YAMAHA_AV rsp="GET" RC="0"><Tuner><Play_Info><Feature_Availability>Not Ready</Feature_Availability><Search_Mode>Tuning</Search_Mode><Preset><Preset_Sel>14</Preset_Sel></Preset><Tuning><Band>FM</Band><Freq><Current><Val>9030</Val><Exp>2</Exp><Unit>MHz</Unit></Current><FM><Val>9030</Val><Exp>2</Exp><Unit>MHz</Unit></FM><AM><Val>1134</Val><Exp>0</Exp><Unit>kHz</Unit></AM></Freq></Tuning><FM_Mode>Mono</FM_Mode><Signal_Info><Tuned>Negate</Tuned><Stereo>Negate</Stereo></Signal_Info><Meta_Info><Program_Type></Program_Type><Program_Service></Program_Service><Radio_Text_A></Radio_Text_A><Radio_Text_B></Radio_Text_B><Clock_Time></Clock_Time></Meta_Info></Play_Info></Tuner></YAMAHA_AV>';
const YTUNER_STATIONS =
  '<ListOfItems><ItemCount>12</ItemCount><Item><ItemType>Station</ItemType><StationId>MS_D175682BA766</StationId><StationName>1LIVE</StationName><StationUrl>http://wdr-1live-live.icecast.wdr.de/wdr/1live/live/mp3/128/stream.mp3</StationUrl><StationDesc>My favorite "1LIVE"</StationDesc><Logo>http://radioyamaha.vtuner.com/ytuner/icon?id=MS_D175682BA766</Logo><StationFormat>Duesseldorf FM</StationFormat><StationLocation></StationLocation><StationBandWidth></StationBandWidth><StationMime></StationMime><Relia>3</Relia><Bookmark>http://radioyamaha.vtuner.com/setupapp/favxml.asp?id=MS_D175682BA766&amp;fav=add</Bookmark></Item></ListOfItems>';
const YTUNER_EMPTY =
  "<ListOfItems><ItemCount>1</ItemCount><Item><ItemType>Display</ItemType><Display>No station(s) found</Display></Item></ListOfItems>";
const POSITION_INFO = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
	<s:Body>
		<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
			<Track>1</Track>
			<TrackDuration>0:05:32</TrackDuration>
			<TrackMetaData></TrackMetaData>
			<TrackURI>http://192.168.1.15:8096/Audio/b8f0216f21724320298e0ed0b607676b/stream.mp3?static=true&amp;api_key=x</TrackURI>
			<RelTime>0:01:02</RelTime>
			<AbsTime>0:01:02</AbsTime>
			<RelCount>0</RelCount>
			<AbsCount>0</AbsCount>
		</u:GetPositionInfoResponse>
	</s:Body>
</s:Envelope>`;

describe("Yamaha XML parsing", () => {
  it("parses List_Info by tag name regardless of wrapper", () => {
    const info = parseListInfo(LIST_INFO);
    expect(info.status).toBe("Ready");
    expect(info.layer).toBe(3);
    expect(info.name).toBe("Duesseldorf FM");
    expect(info.currentLine).toBe(5);
    expect(info.maxLine).toBe(12);
    expect(info.lines).toHaveLength(8);
    expect(info.lines[0]).toEqual({ line: 1, text: "1LIVE", attribute: "Item" });
    expect(info.lines[6]?.text).toBe("Antenne Duesseldorf");
    // The wrapper around Current_Line may differ on other firmware: only the tag name matters.
    expect(parseListInfo(LIST_INFO.replace(/Cursor_Position/g, "Whatever")).currentLine).toBe(5);
  });

  it("drops the empty placeholder lines of an unloaded menu", () => {
    const empty =
      '<YAMAHA_AV rsp="GET" RC="0"><NET_RADIO><List_Info><Menu_Status>Ready</Menu_Status><Menu_Layer>1</Menu_Layer><Menu_Name></Menu_Name><Current_List><Line_1><Txt></Txt><Attribute>Unselectable</Attribute></Line_1><Line_2><Txt></Txt><Attribute>Unselectable</Attribute></Line_2></Current_List><Cursor_Position><Current_Line>1</Current_Line><Max_Line>0</Max_Line></Cursor_Position></List_Info></NET_RADIO></YAMAHA_AV>';
    expect(parseListInfo(empty)).toEqual({
      status: "Ready",
      layer: 1,
      name: "",
      currentLine: 1,
      maxLine: 0,
      lines: [],
    });
  });

  it("parses Play_Info", () => {
    expect(parseNetRadioPlayInfo(PLAY_INFO)).toEqual({
      ready: true,
      playing: true,
      station: "1LIVE",
      song: "Zara Larsson - Memory Lane",
      album: "",
    });
  });

  it("parses Basic_Status with scaled volume", () => {
    expect(parseBasicStatus(BASIC_STATUS)).toEqual({
      power: true,
      input: "NET RADIO",
      volumeDb: -35,
      muted: false,
    });
    expect(parseBasicStatus(BASIC_STATUS.replace("<Val>-350", "<Val>-445")).volumeDb).toBe(-44.5);
    expect(parseBasicStatus(BASIC_STATUS.replace("<Power>On", "<Power>Standby")).power).toBe(false);
  });

  it("parses Tuner Play_Info", () => {
    const t = parseTunerPlayInfo(TUNER_INFO);
    expect(t.ready).toBe(false);
    expect(t.band).toBe("FM");
    expect(t.mhz).toBe(90.3);
    expect(t.preset).toBe(14);
    expect(t.stereo).toBe(false);
  });

  it("escapes and unescapes XML text", () => {
    expect(xmlEscape(`Tom & "Jerry" <3 'x'`)).toBe(
      "Tom &amp; &quot;Jerry&quot; &lt;3 &apos;x&apos;",
    );
    expect(xmlUnescape("a &amp;lt; b &#233; &#xe9;")).toBe("a &lt; b é é");
  });
});

describe("YTuner XML", () => {
  it("parses stations with id, url, logo and bookmark URL", () => {
    const [s] = parseYtunerStations(YTUNER_STATIONS);
    expect(s).toEqual({
      id: "MS_D175682BA766",
      name: "1LIVE",
      url: "http://wdr-1live-live.icecast.wdr.de/wdr/1live/live/mp3/128/stream.mp3",
      logo: "http://radioyamaha.vtuner.com/ytuner/icon?id=MS_D175682BA766",
      bookmark: "http://radioyamaha.vtuner.com/setupapp/favxml.asp?id=MS_D175682BA766&fav=add",
      format: "Duesseldorf FM",
    });
    expect(rewriteToBase(s!.bookmark!, "http://ytuner/")).toBe(
      "http://ytuner/setupapp/favxml.asp?id=MS_D175682BA766&fav=add",
    );
  });
  it("treats the 'No station(s) found' display item as an empty list", () => {
    expect(parseYtunerStations(YTUNER_EMPTY)).toEqual([]);
    expect(parseYtunerStations("")).toEqual([]);
  });
  it("maps a YTuner station onto the local catalog by stream url", () => {
    const urls = RADIO_LISTS.find((l) => l.id === "local")!.stations.map((s) => s.url);
    expect(urls).toContain(parseYtunerStations(YTUNER_STATIONS)[0]!.url);
    expect(RADIO_LISTS.map((l) => l.id)).toContain("local");
    expect(FAVOURITES_LIST_ID).toBe("favourites");
    expect(CATALOG_LOGO_HOSTS).toContain("www1.wdr.de");
  });
});

describe("queue advance at a track end", () => {
  it("pushes the next track when the amp reports STOPPED at 0:00 of the current one", () => {
    const q = {
      id: "q",
      title: "t",
      index: 0,
      status: "playing" as const,
      startedAt: 1,
      offsetMs: 0,
      nextPushed: false,
      tracks: [
        {
          id: "aaaaaaaa",
          title: "a",
          artist: null,
          album: null,
          durationMs: 200_000,
          container: "mp3",
          artItemId: null,
          streamUrl: "http://j/Audio/aaaaaaaa/stream.mp3?static=true",
        },
        {
          id: "bbbbbbbb",
          title: "b",
          artist: null,
          album: null,
          durationMs: 200_000,
          container: "mp3",
          artItemId: null,
          streamUrl: "http://j/Audio/bbbbbbbb/stream.mp3?static=true",
        },
      ],
    } as unknown as Parameters<typeof decideAdvance>[0];
    const pos = {
      track: 1,
      trackUri: "http://j/Audio/aaaaaaaa/stream.mp3?static=true",
      durationMs: 200_000,
      relTimeMs: 0,
    };
    expect(decideAdvance(q, pos, "STOPPED").kind).toBe("push-next");
    expect(decideAdvance(q, { ...pos, relTimeMs: 50_000 }, "PLAYING").kind).toBe("wait");
    expect(
      decideAdvance(
        q,
        { ...pos, trackUri: "http://j/Audio/bbbbbbbb/stream.mp3?static=true" },
        "PLAYING",
      ).kind,
    ).toBe("amp-advanced");
  });
});

describe("AVTransport", () => {
  it("builds DIDL-Lite with escaped values and the mp3 protocolInfo", () => {
    const didl = buildDidl({
      title: "Rock & Roll <Live>",
      artist: 'Band "X"',
      album: null,
      albumArtUri: "http://j/Items/1/Images/Primary?maxWidth=200",
      url: "http://j/Audio/1/stream.mp3?static=true&api_key=k",
      durationMs: 332000,
    });
    expect(didl).toContain("<dc:title>Rock &amp; Roll &lt;Live&gt;</dc:title>");
    expect(didl).toContain("<upnp:artist>Band &quot;X&quot;</upnp:artist>");
    expect(didl).not.toContain("<upnp:album>");
    expect(didl).toContain(
      '<res protocolInfo="http-get:*:audio/mpeg:*" duration="0:05:32">http://j/Audio/1/stream.mp3?static=true&amp;api_key=k</res>',
    );
  });
  it("escapes the DIDL a second time inside the SOAP argument", () => {
    const didl = buildDidl({ title: "A & B", url: "http://j/a.mp3" });
    const soap = soapEnvelope("SetAVTransportURI", {
      CurrentURI: "http://j/a.mp3?x=1&y=2",
      CurrentURIMetaData: didl,
    });
    expect(soap).toContain("<InstanceID>0</InstanceID>");
    expect(soap).toContain("<CurrentURI>http://j/a.mp3?x=1&amp;y=2</CurrentURI>");
    expect(soap).toContain("&lt;dc:title&gt;A &amp;amp; B&lt;/dc:title&gt;");
    expect(soap).toContain(
      "&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;",
    );
  });
  it("parses GetPositionInfo and H:MM:SS", () => {
    const p = parsePositionInfo(POSITION_INFO);
    expect(p.durationMs).toBe(332000);
    expect(p.relTimeMs).toBe(62000);
    expect(trackIdFromUri(p.trackUri)).toBe("b8f0216f21724320298e0ed0b607676b");
    expect(parseHms("1:02:03.500")).toBe(3723500);
    expect(parseHms("NOT_IMPLEMENTED")).toBeNull();
    expect(formatHms(3723500)).toBe("1:02:03");
  });
});

describe("Jellyfin stream URL", () => {
  it("uses the static stream for native containers and transcodes ogg/opus", () => {
    expect(pickStreamUrl("http://j/", "k", "id1", "mp3")).toBe(
      "http://j/Audio/id1/stream.mp3?static=true",
    );
    expect(pickStreamUrl("http://j", "k", "id1", "flac")).toBe(
      "http://j/Audio/id1/stream.flac?static=true",
    );
    expect(pickStreamUrl("http://j", "k", "id1", "ogg")).toContain(
      "/Audio/id1/universal?container=mp3&audioCodec=mp3",
    );
    expect(pickStreamUrl("http://j", "k", "id1", "opus")).toContain("/universal?");
    expect(pickStreamUrl("http://j", "k", "id1", "mov,mp4,m4a,3gp,3g2,mj2")).toContain(
      "/universal?",
    );
    expect(pickStreamUrl("http://j", "k", "id1", null)).toContain("/universal?");
  });
});

const track = (id: string, durationMs: number): QueueTrack => ({
  id,
  title: id,
  artist: "a",
  album: "b",
  albumId: null,
  durationMs,
  container: "mp3",
  artItemId: null,
  streamUrl: `http://j/Audio/${id}/stream.mp3?static=true&api_key=k`,
});
const queue = (over: Partial<QueueState> = {}): QueueState => ({
  id: "q",
  title: "t",
  tracks: [track("t1", 10000), track("t2", 20000), track("t3", 5000)],
  index: 0,
  status: "playing",
  startedAt: 1000,
  offsetMs: 0,
  nextPushed: true,
  ...over,
});

describe("queue arithmetic", () => {
  it("reports progress from our own clock, clamped to the duration", () => {
    expect(queueProgress(queue(), 4000)).toMatchObject({
      index: 0,
      count: 3,
      positionMs: 3000,
      durationMs: 10000,
      status: "playing",
    });
    expect(queueProgress(queue(), 50000)?.positionMs).toBe(10000);
    expect(
      queueProgress(queue({ status: "paused", startedAt: null, offsetMs: 2500 }), 99999)
        ?.positionMs,
    ).toBe(2500);
    expect(queueProgress(queue(), 4000)?.track).not.toHaveProperty("streamUrl");
    expect(queueProgress(null, 0)).toBeNull();
  });
  it("is due only once the track is over and advances to the next track / end", () => {
    expect(queueDue(queue(), 5000)).toBe(false);
    expect(queueDue(queue(), 10700)).toBe(true);
    expect(queueDue(queue({ status: "paused", startedAt: null }), 99999)).toBe(false);
    const q2 = queueAdvance(queue(), 11000);
    expect(q2).toMatchObject({
      index: 1,
      status: "playing",
      startedAt: 11000,
      offsetMs: 0,
      nextPushed: false,
    });
    expect(queueAdvance(queue({ index: 2 }), 1)).toMatchObject({ status: "ended" });
  });
  it("reconciles with GetPositionInfo", () => {
    const q = queue();
    const pos = (id: string, relTimeMs: number) => ({
      track: 1,
      trackUri: `http://j/Audio/${id}/stream.mp3?static=true&api_key=k`,
      durationMs: null,
      relTimeMs,
    });
    expect(decideAdvance(q, pos("t2", 1500))).toEqual({ kind: "amp-advanced", relTimeMs: 1500 });
    expect(decideAdvance(q, pos("t1", 4000))).toEqual({ kind: "wait", relTimeMs: 4000 });
    expect(decideAdvance(q, pos("t1", 9800))).toEqual({ kind: "push-next" });
    expect(decideAdvance(q, null)).toEqual({ kind: "push-next" });
  });
});

describe("snapshot from HA states", () => {
  const st = (
    entity_id: string,
    state: string,
    attributes: Record<string, unknown> = {},
  ): HaState => ({ entity_id, state, attributes }) as HaState;
  it("maps NET RADIO play info and the catalog station", () => {
    const states = new Map(
      [
        st("media_player.r_n500_main", "playing", {
          source: "NET RADIO",
          volume_level: 0.37,
          media_channel: "1LIVE",
        }),
        st("number.r_n500_main_volume_db", "-44.5"),
        st("switch.smart_switch_23081678814571510d0548e1e9d69992_outlet", "on"),
        st("media_player.bravia_xr_65x90k", "off"),
      ].map((s) => [s.entity_id, s]),
    );
    const snap = buildMediaSnapshot(states, { playInfo: parseNetRadioPlayInfo(PLAY_INFO) });
    expect(snap.amp).toEqual({
      available: true,
      on: true,
      state: "playing",
      source: "NET RADIO",
      volumeDb: -44.5,
      volume: 0.37,
      muted: false,
    });
    expect(snap.nowPlaying).toMatchObject({
      kind: "radio",
      station: "1LIVE",
      title: "Zara Larsson - Memory Lane",
      stationId: "1live",
    });
    expect(snap.plugOn).toBe(true);
    expect(snap.tv.state).toBe("off");
  });
  it("reports an off / unavailable amp without inventing a source", () => {
    const off = buildMediaSnapshot(
      new Map([
        ["media_player.r_n500_main", st("media_player.r_n500_main", "off", { source: "SERVER" })],
      ]),
    );
    expect(off.amp.on).toBe(false);
    expect(off.nowPlaying.kind).toBe("none");
    expect(buildMediaSnapshot(new Map()).amp.available).toBe(false);
  });
  it("demo music lists page", () => {
    expect(demoMusicList("mixes", 0).items.map((i) => i.id)).toEqual([
      "daily",
      "discover",
      "relaxed",
      "evening",
    ]);
  });
});

describe("image route allowlist", () => {
  it("allows catalog logo hosts and the vTuner host, rejects others", () => {
    expect(imageHostAllowed(new URL("https://www1.wdr.de/x.png"))).toBe(true);
    expect(imageHostAllowed(new URL("http://radioyamaha.vtuner.com/ytuner/icon?id=1"))).toBe(true);
    expect(imageHostAllowed(new URL("https://evil.example/x.png"))).toBe(false);
    expect(imageHostAllowed(new URL("file:///etc/passwd"))).toBe(false);
  });
});
