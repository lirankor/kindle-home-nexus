// Stream relay for the Yamaha R-N500: it only plays plain http streams, many stations only offer https.
// GET /s/<station id>  ->  fetches the station's https (or http) stream from the catalog and pipes it
// unchanged (no transcoding; Icecast MP3/AAC in, same bytes out). HLS is not supported here.
// Allowlist = src/data/radio-stations.json (mounted read-only); nothing else can be relayed.
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

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

function open(url, hops, cb) {
  if (hops > 5) return cb(new Error("too many redirects"));
  const mod = url.startsWith("https:") ? https : http;
  const req = mod.get(url, { headers: { "User-Agent": UA, "Icy-MetaData": "0", Accept: "*/*" }, timeout: 15000 }, (up) => {
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
    open(st.url, 0, (err, up) => {
      if (err) {
        clients--;
        log(`! ${st.id}: ${err.message}`);
        if (!res.headersSent) res.writeHead(502);
        return res.end();
      }
      const type = up.headers["content-type"] || (st.codec === "AAC" ? "audio/aac" : "audio/mpeg");
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", Connection: "close", "icy-name": st.name });
      up.pipe(res);
      const done = () => {
        clients--;
        log(`- ${st.id} (${clients})`);
        up.destroy();
      };
      res.on("close", done);
      up.on("error", () => res.destroy());
    });
  })
  .listen(PORT, "0.0.0.0");
