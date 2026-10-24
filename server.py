#!/usr/bin/env python3
"""
SAFI TV+ Home Server + Stream Booster (v2.0)

Serves the TV app from ./web AND provides /proxy, a media-only booster that
fetches HLS playlists/segments server-side and re-serves them with open CORS
headers + rewritten playlist URLs. This makes many streams that a browser
blocks (CORS / referrer rules) play normally inside SAFI TV+.

Run on your HOME network / computer:
    python3 server.py          (port 8000)
Then open http://<this-computer-IP>:8000 on the TV browser.

SECURITY: /proxy only allows media file types, but it is still a proxy —
use it on your home LAN only, never publish this port to the internet.
(In the Android APK the same booster runs natively inside the app, so
no server is needed there.)
"""
import http.server, socketserver, urllib.request, urllib.parse, urllib.error
import ipaddress, os, re, socket, sys, mimetypes, json, time

WEB_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ALLOWED_EXT = (".m3u8", ".ts", ".m4s", ".cmfv", ".cmfa", ".aac", ".mp3",
               ".vtt", ".key", ".m4v", ".mp4", ".webm", ".jpg", ".jpeg", ".png")
UA = ("Mozilla/5.0 (SMART-TV; Linux; Android TV) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

def is_media_url(u: str) -> bool:
    path = urllib.parse.urlparse(u).path.lower()
    return path.endswith(ALLOWED_EXT)

# The Booster is for a trusted home LAN. By default it will not fetch hosts that
# resolve to this computer, the LAN, link-local/cloud-metadata or other
# non-public addresses. Set SAFI_ALLOW_PRIVATE_STREAMS=1 only if you deliberately
# want to proxy a media server on your own trusted LAN.
_ALLOW_PRIVATE = os.environ.get("SAFI_ALLOW_PRIVATE_STREAMS", "").lower() in ("1", "true", "yes")
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}
_BLOCKED_NETS = tuple(ipaddress.ip_network(x) for x in (
    "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
    "::1/128", "fe80::/10", "fc00::/7", "::/128",
))
_HOST_CACHE = {}
_ALWAYS_BLOCKED = tuple(ipaddress.ip_network(x) for x in ("127.0.0.0/8", "169.254.0.0/16", "::1/128", "fe80::/10"))

def _ip_blocked(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if any(addr in n for n in _ALWAYS_BLOCKED):
        return True
    return (not _ALLOW_PRIVATE) and any(addr in n for n in _BLOCKED_NETS)

def host_is_allowed(host: str) -> bool:
    if not host:
        return False
    h = host.rstrip(".").lower()
    if h in _BLOCKED_HOSTS:
        return False
    now = time.monotonic()
    hit = _HOST_CACHE.get(h)
    if hit and hit[1] > now:
        return hit[0]
    ok = False
    try:
        # Literal IP addresses do not need DNS.
        try:
            ok = not _ip_blocked(ipaddress.ip_address(h))
        except ValueError:
            infos = socket.getaddrinfo(h, None, proto=socket.IPPROTO_TCP)
            ips = {info[4][0] for info in infos}
            ok = bool(ips) and all(not _ip_blocked(ip) for ip in ips)
    except Exception:
        ok = False
    _HOST_CACHE[h] = (ok, now + 300)
    return ok

def validate_target(url: str) -> bool:
    try:
        p = urllib.parse.urlparse(url)
        if p.scheme not in ("http", "https") or p.username or p.password or not p.hostname:
            return False
        if not is_media_url(url):
            return False
        port = p.port or (443 if p.scheme == "https" else 80)
        if port < 1024 and port not in (80, 443):
            return False
        return host_is_allowed(p.hostname)
    except Exception:
        return False

class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not validate_target(newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def upstream_open(url, range_header=None, timeout=20):
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "*/*")
    req.add_header("Accept-Encoding", "identity")
    p = urllib.parse.urlparse(url)
    req.add_header("Referer", f"{p.scheme}://{p.netloc}/")
    req.add_header("Origin", f"{p.scheme}://{p.netloc}")
    if range_header:
        req.add_header("Range", range_header)
    opener = urllib.request.build_opener(SafeRedirectHandler())
    return opener.open(req, timeout=timeout)

def rewrite_playlist(text, base_url, proxy_prefix):
    def prox(absu):
        return proxy_prefix + urllib.parse.quote(absu, safe="") if absu.startswith(("http://", "https://")) else absu
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line); continue
        if s.startswith("#"):
            # rewrite URI="..." attributes (keys, subtitles, audio renditions...)
            s = re.sub(r'URI="([^"]+)"',
                       lambda m: 'URI="%s"' % prox(urllib.parse.urljoin(base_url, m.group(1))), s)
            out.append(s)
        else:
            out.append(prox(urllib.parse.urljoin(base_url, s)))
    return "\n".join(out) + "\n"

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

def cors_headers(handler):
    origin = handler.headers.get("Origin")
    host = handler.headers.get("Host")
    if origin and host and urllib.parse.urlparse(origin).netloc == host:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Accept, Content-Type",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range",
            "Vary": "Origin",
        }
    return {}

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in cors_headers(self).items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy":
            return self._send(405, b"Use GET for media")
        return self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/__proxy_health__":
            return self._send(200, json.dumps({"ok": True, "service": "safi-booster", "version": "2.0"}).encode(),
                              "application/json")
        if parsed.path == "/proxy":
            return self.handle_proxy(parsed)
        return self.handle_static(parsed)

    # ---------- booster ----------
    def handle_proxy(self, parsed):
        # Basic abuse guard: refuse obvious cross-site hotlinking of the booster.
        sfs = self.headers.get("Sec-Fetch-Site")
        if sfs and sfs not in ("same-origin", "same-site", "none"):
            return self._send(403, b"Booster is for the SAFI TV+ app on this server only.")
        ref = self.headers.get("Origin") or self.headers.get("Referer")
        if ref and urllib.parse.urlparse(ref).netloc and urllib.parse.urlparse(ref).netloc != self.headers.get("Host"):
            return self._send(403, b"Booster is for the SAFI TV+ app on this server only.")
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("u") or [""])[0]
        if not validate_target(target):
            return self._send(400, b"Booster allows public media (HLS/video) URLs only.")
        try:
            resp = upstream_open(target, range_header=self.headers.get("Range"))
        except urllib.error.HTTPError as e:
            return self._send(e.code if 400 <= e.code < 600 else 502, f"Upstream returned {e.code}".encode())
        except Exception:
            return self._send(502, b"Booster could not reach the stream server.")

        final_url = resp.geturl()
        if not validate_target(final_url):
            try: resp.close()
            except Exception: pass
            return self._send(502, b"Booster blocked an unsafe redirect.")
        ctype_up = (resp.headers.get_content_type() or "").lower()
        path_low = urllib.parse.urlparse(final_url).path.lower()
        looks_playlist = path_low.endswith(".m3u8") or "mpegurl" in ctype_up
        try:
            if looks_playlist:
                raw = resp.read(3_000_000)
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = raw.decode("latin-1")
                if "#EXTM3U" not in text[:600]:
                    # not actually a playlist: pass through untouched
                    return self._send(200, raw, "application/vnd.apple.mpegurl")
                # Relative prefix: works on http LAN and https previews alike
                prefix = "/proxy?u="
                body = rewrite_playlist(text, final_url, prefix).encode("utf-8")
                return self._send(200, body, "application/vnd.apple.mpegurl",
                                   {"Cache-Control": "no-cache"})
            # media segment / file: stream through in chunks
            code = 206 if resp.status == 206 else 200
            length = resp.headers.get("Content-Length")
            ctype = ctype_up or mimetypes.guess_type(path_low)[0] or "application/octet-stream"
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            if length:
                self.send_header("Content-Length", length)
            for k, v in SECURITY_HEADERS.items():
                self.send_header(k, v)
            for k, v in cors_headers(self).items():
                self.send_header(k, v)
            for h in ("Content-Range", "Accept-Ranges"):
                if resp.headers.get(h):
                    self.send_header(h, resp.headers.get(h))
            self.end_headers()
            while True:
                chunk = resp.read(262144)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._send(502, b"Booster error.")
            except Exception:
                pass
        finally:
            try: resp.close()
            except Exception: pass

    # ---------- static app ----------
    def handle_static(self, parsed):
        rel = urllib.parse.unquote(parsed.path).lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(WEB_ROOT, rel))
        try:
            inside = os.path.commonpath([WEB_ROOT, full]) == WEB_ROOT
        except ValueError:
            inside = False
        if not inside or not os.path.isfile(full):
            return self._send(404, b"Not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        cache_hdr = "no-cache, must-revalidate" if full.lower().endswith((".html", ".js", ".css")) else "public, max-age=86400"
        size = os.path.getsize(full)
        rng = self.headers.get("Range")
        f = open(full, "rb")
        if rng:
            m = re.fullmatch(r"bytes=(\d+)-(\d*)", rng.strip())
            if m:
                start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
                if start >= size or end < start:
                    f.close()
                    return self._send(416, b"Range not satisfiable", extra={"Content-Range": f"bytes */{size}"})
                end = min(end, size - 1); length = end - start + 1
                f.seek(start)
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(length))
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Cache-Control", cache_hdr)
                for k, v in SECURITY_HEADERS.items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(f.read(length))
                f.close(); return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache_hdr)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            while True:
                chunk = f.read(262144)
                if not chunk: break
                self.wfile.write(chunk)
        f.close()

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"SAFI TV+ server + Booster running on http://0.0.0.0:{PORT}  (web root: {WEB_ROOT})", flush=True)
        httpd.serve_forever()
