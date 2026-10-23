// Bus task 027: the Music Assistant client screens (MUSIC_BACKEND=ha): the Library (a plain list of MA's sections),
// Discover (MA's Home rows) and the MA radio dial (MA's radios on the amp dial's slider component). State and keys:
// src/lib/use-library.ts through useMediaPanel.
import { useState } from "react";
import {
  BookAudio,
  Disc3,
  Heart,
  ListMusic,
  MicVocal,
  Music2,
  Play,
  Podcast,
  Radio,
  Tags,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioDial } from "@/components/dial-bar";
import { FullModal } from "@/components/light-modals";
import { TransportControl } from "@/components/media-screens";
import { tryT } from "@/lib/i18n";
import type { Key } from "@/lib/i18n";
import { LIBRARY_PAGE_SIZE, isFavourite, maStations } from "@/lib/library";
import type { LibItem, LibMediaType, LibraryTab } from "@/lib/library";
import { SEARCH_MIN_CHARS } from "@/lib/media";
import {
  SEARCH_KEYS,
  SEARCH_KEY_ROWS,
  displayDb,
  radioSongLine,
  transportMode,
} from "@/lib/media-ui";
import type { MediaPanel } from "@/lib/media-panel";
import type { LibRow } from "@/lib/use-library";

const Ltr = ({ children }: { children: React.ReactNode }) => <bdi dir="ltr">{children}</bdi>;
const KIND_ICONS: Record<LibMediaType, typeof Music2> = {
  artist: MicVocal,
  album: Disc3,
  track: Music2,
  playlist: ListMusic,
  radio: Radio,
  podcast: Podcast,
  podcast_episode: Podcast,
  audiobook: BookAudio,
  genre: Tags,
};
/** Search results shown under the keyboard (a window that follows the cursor). */
const SEARCH_ROWS_SHOWN = 5;

/** MA's cover through /media/img ("ma:" token, fetched via HA); the kind's glyph when there is none. */
function LibArt({ item, size }: { item: LibItem; size: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = !!item.art && failed !== item.art;
  const Icon = KIND_ICONS[item.mediaType] ?? Music2;
  return (
    <span className="radio-logo music-art" style={{ width: size, height: size }} aria-hidden="true">
      {show ? (
        <img
          src={`/media/img?item=${encodeURIComponent(item.art!)}&w=${size}`}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(item.art)}
        />
      ) : (
        <Icon size={Math.round(size * 0.55)} strokeWidth={1.4} />
      )}
    </span>
  );
}

/** One two-line row (task 023's clamp): cover, name, the second line, a heart when it is a favourite. */
function LibItemRow({
  panel,
  item,
  selected,
  detail,
  onClick,
}: {
  panel: MediaPanel;
  item: LibItem;
  selected: boolean;
  detail?: string | null;
  onClick?: () => void;
}) {
  const fav = isFavourite(item, panel.library.favs);
  return (
    <Button
      variant="eink"
      className="source-row music-row lib-row"
      role="option"
      aria-selected={selected}
      aria-pressed={selected}
      data-kind={item.mediaType}
      data-opens={item.opens || undefined}
      onClick={onClick}
    >
      <LibArt item={item} size={46} />
      <span className="source-row-text">
        <strong>{item.name}</strong>
        <span>{detail ?? item.sub ?? " "}</span>
      </span>
      {fav && (
        <Heart className="lib-fav" size={22} strokeWidth={2} fill="currentColor" aria-label="♥" />
      )}
    </Button>
  );
}

const kindLabel = (panel: MediaPanel, t: LibMediaType) => panel.t(`lib.kind.${t}` as Key);
const tabLabel = (panel: MediaPanel, tab: LibraryTab) => panel.t(`lib.tab.${tab}` as Key);

/** The sections list (2026-10-23, the owner's call): one row per MA section in the owner's order, Discover's category
 *  rows (footer-button width), no heading; Enter opens a section. The page text only when it paginates. */
function SectionsList({ panel, status }: { panel: MediaPanel; status: string }) {
  const lib = panel.library;
  const first = lib.sectionsPage * lib.sectionsPageSize;
  return (
    <FullModal
      label={panel.t("amp.library")}
      actions={panel.modalActions}
      status={status}
      compactStatus
    >
      <div
        className="source-rows music-rows discover-rows lib-sections"
        role="listbox"
        aria-label={panel.t("amp.library")}
      >
        {lib.sections.slice(first, first + lib.sectionsPageSize).map((tab, i) => (
          <Button
            key={tab}
            variant="eink"
            className="source-row discover-category"
            role="option"
            data-tab={tab}
            aria-selected={first + i === lib.sectionsCursor}
            aria-pressed={first + i === lib.sectionsCursor}
            onClick={() => lib.selectTab(tab)}
          >
            <span className="source-row-text">
              <strong>{tabLabel(panel, tab)}</strong>
            </span>
          </Button>
        ))}
      </div>
      {lib.sectionsPages > 1 && (
        <div className="music-foot discover-foot">
          <strong className="music-page">
            <Ltr>
              {lib.sectionsPage + 1}/{lib.sectionsPages}
            </Ltr>
          </strong>
        </div>
      )}
    </FullModal>
  );
}

function SearchTab({ panel }: { panel: MediaPanel }) {
  const lib = panel.library;
  const { t } = panel;
  const typed = lib.search.query.trim().length >= SEARCH_MIN_CHARS;
  const loading = typed && lib.searchLoading && lib.searchRows.length === 0 && !lib.searchError;
  const first = Math.max(
    0,
    Math.min(lib.searchCursor - (SEARCH_ROWS_SHOWN - 1), lib.searchRows.length - SEARCH_ROWS_SHOWN),
  );
  let keyIndex = 0;
  return (
    <>
      <div className="search-field lib-search-field" dir="ltr" data-empty={lib.search.query === ""}>
        {lib.search.query === "" ? (
          <span className="search-placeholder">{t("lib.searchPlaceholder")}</span>
        ) : (
          <>
            <span className="search-text">{lib.search.query}</span>
            <span className="search-caret" aria-hidden />
          </>
        )}
      </div>
      <div
        className="search-keys"
        dir="ltr"
        role="grid"
        aria-label={t("search.keyboard")}
        data-focus={lib.search.focus}
      >
        {SEARCH_KEY_ROWS.en.map((row, r) => (
          <div key={r} role="row">
            {row.map((ch) => {
              const index = keyIndex++;
              const active = index === lib.search.key;
              return (
                <Button
                  key={ch}
                  variant="eink"
                  className="search-key"
                  role="gridcell"
                  aria-selected={lib.search.focus === "keys" && active}
                  aria-pressed={active}
                  tabIndex={-1}
                  onClick={() => {
                    lib.setSearchKey(index);
                    lib.typeChar(SEARCH_KEYS[index] ?? ch);
                  }}
                >
                  {ch}
                </Button>
              );
            })}
          </div>
        ))}
      </div>
      <div
        className="source-rows music-rows search-rows"
        role="listbox"
        aria-label={t("search.results")}
      >
        {loading && <p className="music-note">{t("music.loading")}</p>}
        {lib.searchError && <p className="radio-error">{lib.searchError}</p>}
        {typed && !loading && !lib.searchError && lib.searchRows.length === 0 && (
          <p className="music-note">{t("search.empty")}</p>
        )}
        {lib.searchRows.slice(first, first + SEARCH_ROWS_SHOWN).map((item, i) => (
          <LibItemRow
            key={`${item.uri}`}
            panel={panel}
            item={item}
            selected={lib.search.focus === "results" && first + i === lib.searchCursor}
            detail={[kindLabel(panel, item.mediaType), item.sub].filter(Boolean).join(" · ")}
          />
        ))}
      </div>
    </>
  );
}

function rowKey(r: LibRow) {
  return r.kind === "playAll" ? `all:${r.parent.uri}` : r.item.uri;
}

/** The Library (F2 on the music screen): the sections list, Enter opens one; Up / Down through its list (pages of 8),
 *  Enter plays now (any row) and returns to the music screen, F2 play next, F3 add to queue, F4 Open on an artist /
 *  album / playlist / podcast / genre (its "Play all" row then carries the heart), else the heart (bus task 029). */
export function LibraryScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const lib = panel.library;
  const { t } = panel;
  if (lib.section === null) return <SectionsList panel={panel} status={status} />;
  const parent = lib.list?.parent ?? lib.opened;
  const loading = lib.listLoading && !lib.listError;
  return (
    <FullModal label={t("amp.library")} actions={panel.modalActions} status={status} compactStatus>
      {!lib.opened && (
        // the section's name above its top list, as Discover's items level (search: the name only)
        <header className="modal-heading radio-list-heading discover-heading lib-section-heading">
          <h1>{tabLabel(panel, lib.tab)}</h1>
          {lib.tab !== "search" && (
            <p>{lib.list ? t("lib.count", { n: String(lib.list.total) }) : "\u00a0"}</p>
          )}
        </header>
      )}
      {lib.tab === "search" && !lib.opened ? (
        <SearchTab panel={panel} />
      ) : (
        <>
          {lib.opened && (
            <header className="lib-heading">
              {parent && <LibArt item={parent} size={52} />}
              <div>
                <h2>{parent?.name ?? "…"}</h2>
                <p>
                  {[parent?.sub, lib.list ? t("lib.count", { n: lib.list.total }) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </header>
          )}
          <div
            className="source-rows music-rows lib-rows"
            data-opened={lib.opened ? "true" : undefined}
            role="listbox"
            aria-label={tabLabel(panel, lib.tab)}
            aria-busy={loading}
          >
            {loading && lib.listRows.length === 0 && (
              <p className="music-note">{t("music.loading")}</p>
            )}
            {lib.listError && <p className="radio-error">{lib.listError}</p>}
            {!loading && !lib.listError && lib.listRows.length === 0 && (
              <p className="music-note">{t("music.empty")}</p>
            )}
            {lib.listRows.map((r, i) => {
              const selected = lib.page * LIBRARY_PAGE_SIZE + i === lib.cursor;
              return r.kind === "playAll" ? (
                <Button
                  key={rowKey(r)}
                  variant="eink"
                  className="source-row music-row lib-row lib-playall"
                  role="option"
                  aria-selected={selected}
                  aria-pressed={selected}
                >
                  <span
                    className="radio-logo music-art"
                    style={{ width: 46, height: 46 }}
                    aria-hidden="true"
                  >
                    <Play size={26} strokeWidth={1.6} />
                  </span>
                  <span className="source-row-text">
                    <strong>{t("lib.playAll")}</strong>
                    <span>{r.parent.name}</span>
                  </span>
                </Button>
              ) : (
                <LibItemRow key={rowKey(r)} panel={panel} item={r.item} selected={selected} />
              );
            })}
          </div>
          <div className="music-foot">
            <strong className="music-page">
              <Ltr>
                {Math.min(lib.page, lib.listPages - 1) + 1}/{lib.listPages}
              </Ltr>
            </strong>
          </div>
        </>
      )}
    </FullModal>
  );
}

const rowName = (panel: MediaPanel, id: string, name: string) =>
  tryT(panel.lang, `discover.row.${id}`) ?? name;

/** Discover (the music screen's free key), a plain two-level list (2026-10-21): first the categories of the panel
 *  option media.discover_rows ("Recently played", "Favourite radio stations", …), Enter opens one; then its items
 *  (pages of 7 categories / 8 items, up to 20), Enter plays now and returns to the music screen, F4 the heart, Back climbs a level.
 *  No play next / add / open here. Footer: the position, as the list screens. */
export function DiscoverScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const lib = panel.library;
  const { t } = panel;
  const row = lib.discRow;
  const n = lib.homeRows.length;
  const items =
    row?.items.slice(lib.discPage * lib.discPageSize, (lib.discPage + 1) * lib.discPageSize) ?? [];
  const count = row?.items.length ?? 0;
  const categories = lib.discLevel === "categories";
  return (
    <FullModal
      label={t("discover.title")}
      actions={panel.modalActions}
      status={status}
      compactStatus
    >
      <header className="modal-heading radio-list-heading discover-heading">
        <h1>{row ? rowName(panel, row.id, row.name) : t("discover.title")}</h1>
        {row && <p>{t("lib.count", { n: String(count) })}</p>}
      </header>
      <div
        className="source-rows music-rows discover-rows"
        role="listbox"
        aria-label={row?.name ?? t("discover.title")}
      >
        {lib.homeLoading && <p className="music-note">{t("music.loading")}</p>}
        {lib.homeError && <p className="radio-error">{lib.homeError}</p>}
        {!lib.homeLoading && !lib.homeError && n === 0 && (
          <p className="music-note">{t("discover.empty")}</p>
        )}
        {categories &&
          lib.homeRows
            .slice(lib.discPage * lib.discPageSize, (lib.discPage + 1) * lib.discPageSize)
            .map((r, i) => {
              const index = lib.discPage * lib.discPageSize + i;
              return (
                <Button
                  key={r.id}
                  variant="eink"
                  className="source-row discover-category"
                  role="option"
                  aria-selected={index === lib.discCursor}
                  aria-pressed={index === lib.discCursor}
                >
                  <span className="source-row-text">
                    <strong>{rowName(panel, r.id, r.name)}</strong>
                    <span>{t("lib.count", { n: String(r.items.length) })}</span>
                  </span>
                </Button>
              );
            })}
        {!categories &&
          items.map((item, i) => (
            <LibItemRow
              key={`${row?.id}:${item.uri}`}
              panel={panel}
              item={item}
              selected={lib.discPage * lib.discPageSize + i === lib.discCursor}
              detail={item.sub ?? kindLabel(panel, item.mediaType)}
            />
          ))}
      </div>
      <div className="music-foot discover-foot">
        <strong className="music-page">
          <Ltr>
            {Math.min(lib.discPage, lib.discPages - 1) + 1}/{lib.discPages}
          </Ltr>
        </strong>
      </div>
    </FullModal>
  );
}

/** The MA radio dial (bus task 027 item 8): MA's radios on the amp dial's slider; the band = MA favourites or all MA
 *  radios. Left / Right tunes (plays the station on the player after the needle settles), Enter plays now, Up / Down
 *  volume, F2 the band, F3 the heart, F4 the Radio tab's list, Back where it came from. */
export function MaDialScreen({ panel, status }: { panel: MediaPanel; status: string }) {
  const lib = panel.library;
  const { t, data: s } = panel;
  const on = s?.amp.on ?? false;
  const station = lib.dialStation;
  const playingHere = !!station && !!lib.playingStation && station.name === lib.playingStation;
  const name = station?.name ?? (lib.dialLoading ? "…" : t("radio.empty"));
  const song =
    playingHere && s
      ? radioSongLine(s.nowPlaying)
      : lib.playingStation
        ? `${t("madial.playing")} ${lib.playingStation}`
        : " ";
  const band = t(lib.dial.band === "favourites" ? "madial.band.favourites" : "madial.band.all");
  return (
    <FullModal label={t("madial.title")} actions={panel.modalActions} status={status} compactStatus>
      <div className="screen-stack">
        <div className="radio-now-text">
          <strong className="radio-now-name">{name}</strong>
          <span className="radio-now-song">{song || " "}</span>
          <span className="radio-now-detail">Music Assistant</span>
        </div>
        <div className="radio-cover" data-on={on}>
          {station ? <LibArt item={station} size={200} /> : <Radio size={110} strokeWidth={1.4} />}
        </div>
        <RadioDial
          bandName={band}
          stations={maStations(lib.dialItems)}
          list={lib.dial.band}
          fmBand={false}
          index={lib.dialIndex}
          emptyText={
            lib.dialLoading
              ? ""
              : lib.dial.band === "favourites"
                ? t("radio.noFavourites")
                : t("radio.empty")
          }
        />
        <div className="radio-transport-row" data-on={on}>
          <TransportControl
            db={on && s ? displayDb(s.amp) : null}
            label={t("media.volume")}
            sourceTitle={t("media.output")}
            source={
              s?.output ? (s.output.groupName ?? s.output.name ?? s.output.entity ?? "—") : "—"
            }
            mode={transportMode(s)}
            small
          />
        </div>
      </div>
    </FullModal>
  );
}
