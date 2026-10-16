// Pure amp power derivation (no I/O): what the panel shows as the amp's power state and what the
// power-on routine must do first. Wired in media.server.ts (overlayAmpStatus / runPowerOn).
//
// Seen 2026-10-15: the R-N500 reports standby to HA's yamaha_ynca at once, but ~15 min into standby it
// drops its LAN entirely (ynca → unavailable, no ping); with the plug still on nothing answers, and a
// stale snapshot plus a 30 s last-good XML cache could keep the panel on "on" / "unavailable".

/** Basic_Status fields that matter for power. */
export type XmlPower = { power: boolean; input: string | null };

/** How long a last-good Basic_Status still counts when the XML API does not answer (it stalls for a few
 *  seconds after a DLNA resume or an input switch; a longer silence means standby or a sleeping LAN). */
export const AMP_XML_GRACE_MS = 10_000;

export type AmpPowerInput = {
  /** This poll's Basic_Status, null when the XML API did not answer (or AMP_HOST is unset). */
  xml: XmlPower | null;
  /** Last good Basic_Status with its timestamp. */
  cached: { at: number; value: XmlPower } | null;
  now: number;
  /** HA's media_player state (off, on, idle, playing, paused, unavailable, unknown); null = entity unknown. */
  haState: string | null;
  /** The amp's smart plug; null when HA does not know it. */
  plugOn: boolean | null;
  graceMs?: number;
};

export type AmpPowerVia = "xml" | "xml-cached" | "plug-off" | "ha" | "unknown";
export type AmpPowerVerdict = {
  on: boolean;
  /** Something authoritative answered (XML, the plug, or HA). False = unknown, shown as off. */
  available: boolean;
  via: AmpPowerVia;
  input: string | null;
};

const haKnows = (state: string | null): state is string =>
  state !== null && state !== "unavailable" && state !== "unknown";
const haOn = (state: string) => state !== "off" && state !== "standby";

/**
 * XML first (it answers Standby / On directly and does not depend on HA's ynca link), its last good
 * answer within the grace, then the plug (off = the amp is off, whatever HA still remembers), then HA,
 * else unknown — never "on" from a stale source. The `via` is for logs and tests.
 */
export function deriveAmpPower(i: AmpPowerInput): AmpPowerVerdict {
  const grace = i.graceMs ?? AMP_XML_GRACE_MS;
  if (i.xml) return { on: i.xml.power, available: true, via: "xml", input: i.xml.input };
  if (i.cached && i.now - i.cached.at < grace)
    return {
      on: i.cached.value.power,
      available: true,
      via: "xml-cached",
      input: i.cached.value.input,
    };
  if (i.plugOn === false) return { on: false, available: true, via: "plug-off", input: null };
  if (haKnows(i.haState)) return { on: haOn(i.haState), available: true, via: "ha", input: null };
  return { on: false, available: false, via: "unknown", input: null };
}
