// Stream relay for the Yamaha R-N500: it only plays plain http streams, many stations only offer https.
// GET /s/<station id>  ->  fetches the station's https (or http) stream from the catalog and pipes it
// unchanged (no transcoding; Icecast MP3/AAC in, same bytes out). HLS is not supported here.
// Allowlist = src/data/radio-stations.json (mounted read-only); nothing else can be relayed.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import dns from "node:dns";

const PORT = Number(process.env.PORT || 8792);
const CATALOG = process.env.CATALOG || "/app/radio-stations.json";
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS || 4);
const UA = "kindle-home-nexus-relay/1.0";

const stations = new Map();
for (const list of JSON.parse(readFileSync(CATALOG, "utf8")).lists)
  for (const s of list.stations) stations.set(s.id, s);
console.log(`relay: ${stations.size} stations from ${CATALOG}, port ${PORT}`);

let clients = 0;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Redirect targets must be public http(s) hosts: never loopback, link-local or RFC1918 addresses.
function publicTarget(u) {
  let p;
  try {
    p = new URL(u);
  } catch {
    return false;
  }
  if (p.protocol !== "http:" && p.protocol !== "https:") return false;
  const h = p.hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (h.includes(":")) return false; // no IPv6 literals
  return true;
}

// The same ranges, checked on the RESOLVED addresses at connect time (closes DNS rebinding / CNAME tricks).
function privateAddress(addr, family) {
  if (family === 4) {
    const [a, b] = addr.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const h = addr.toLowerCase();
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return v4 ? privateAddress(v4[1], 4) : false;
}
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => privateAddress(a.address, a.family))) return cb(new Error("resolved to a private address"));
    const a = addrs.find((x) => x.family === 4) || addrs[0];
    if (opts && opts.all) return cb(null, [a]);
    cb(null, a.address, a.family);
  });
}

function open(url, hops, cb) {
  if (hops > 5) return cb(new Error("too many redirects"));
  if (!publicTarget(url)) return cb(new Error("target not allowed"));
  const mod = url.startsWith("https:") ? https : http;
  const req = mod.get(url, { lookup: safeLookup, headers: { "User-Agent": UA, "Icy-MetaData": "0", Accept: "*/*" }, timeout: 15000 }, (up) => {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
      up.resume();
      return open(new URL(up.headers.location, url).toString(), hops + 1, cb);
    }
    if (up.statusCode !== 200) {
      up.resume();
      return cb(new Error(`upstream ${up.statusCode}`));
    }
    cb(null, up);
  });
  req.on("timeout", () => req.destroy(new Error("upstream timeout")));
  req.on("error", (e) => cb(e));
}

http
  .createServer((req, res) => {
    const m = /^\/s\/([a-z0-9-]+)\/?$/.exec(req.url || "");
    if (req.url === "/healthz") return res.writeHead(200).end("ok");
    if (!m) return res.writeHead(404).end();
    const st = stations.get(m[1]);
    if (!st) return res.writeHead(404).end();
    if (clients >= MAX_CLIENTS) return res.writeHead(503).end();
    clients++;
    log(`+ ${st.id} (${clients})`);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clients--;
      log(`- ${st.id} (${clients})`);
    };
    res.on("close", release);
    open(st.url, 0, (err, up) => {
      if (err) {
        log(`! ${st.id}: ${err.message}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
        return release();
      }
      const type = up.headers["content-type"] || (st.codec === "AAC" ? "audio/aac" : "audio/mpeg");
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", Connection: "close", "icy-name": st.name });
      up.pipe(res);
      res.on("close", () => up.destroy());
      up.on("error", () => res.destroy());
    });
  })
  .listen(PORT, "0.0.0.0");
