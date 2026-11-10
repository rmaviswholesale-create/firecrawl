"""End-to-end check of the self-host features against a running stack.

Usage:
    python3 smoke.py <api-key> <test-site-url> [results.json]

<api-key> is one of SELF_HOSTED_API_KEYS. <test-site-url> is apps/test-site as
the containers reach it (build it with `pnpm run build` and serve `dist/`).
The stack needs ALLOW_LOCAL_WEBHOOKS=true to scrape a private address, and
LOCAL_CACHE_ENABLED=true for the cache check. Set FIRECRAWL_API_URL to test an
API that is not on localhost:3002. Exits non-zero if any check fails.
"""
import json, os, sys, time, urllib.request, urllib.error

if len(sys.argv) < 3:
    sys.exit(__doc__)

API = os.environ.get("FIRECRAWL_API_URL", "http://localhost:3002")
KEY = sys.argv[1]
SITE = sys.argv[2].rstrip("/")
results = []

def call(method, path, body=None, key=KEY):
    req = urllib.request.Request(API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {"raw": raw[:200].decode(errors="replace")}

def scrape(body, key=KEY):
    return call("POST", "/v2/scrape", body, key)

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS" if ok else "FAIL"), name, "-", str(detail)[:160], flush=True)

page = SITE + "/interact.html"

s, b = scrape({"url": page}, key=None); check("auth: no key rejected", s == 401, s)
s, b = scrape({"url": page}, key="wrong"); check("auth: wrong key rejected", s == 401, s)
s, b = scrape({"url": page}); d = b.get("data", {})
check("auth: valid key accepted + markdown", s == 200 and "Interaction Test" in d.get("markdown", ""), s if s != 200 else "")

s, b = scrape({"url": page, "formats": ["markdown"], "actions": [
    {"type": "click", "selector": "#reveal"}, {"type": "click", "selector": "#name"},
    {"type": "write", "text": "compose"}, {"type": "executeJavascript", "script": "document.title"}]})
d = b.get("data", {})
check("actions", "firecrawl-actions-ok" in d.get("markdown", "") and "Typed: compose" in d.get("markdown", "")
      and (d.get("actions", {}).get("javascriptReturns") or [{}])[0].get("value") == "Interaction Test", b.get("error", ""))

s, b = scrape({"url": page, "formats": [{"type": "screenshot", "fullPage": True}]})
check("screenshot", str(b.get("data", {}).get("screenshot", "")).startswith("data:image/png;base64,"), b.get("error", ""))

s, b = scrape({"url": page, "formats": ["markdown"], "mobile": True})
check("mobile", "Viewport width: 390" in b.get("data", {}).get("markdown", ""), b.get("error", ""))

s, b = scrape({"url": page, "formats": [{"type": "network"}], "waitFor": 1000})
reqs = (b.get("data", {}).get("network") or {}).get("requests", [])
check("network", any("example.json" in r["url"] and r.get("json", {}).get("id") == 1 for r in reqs), b.get("error", "") or len(reqs))

s, b = scrape({"url": page, "formats": ["markdown"], "location": {"country": "JP"}})
md = b.get("data", {}).get("markdown", "")
check("location", "Language: ja-JP" in md and "Timezone: Asia/Tokyo" in md, b.get("error", ""))

s, b = scrape({"url": page, "formats": ["markdown"], "proxy": "stealth"}); d = b.get("data", {})
check("stealth", "Webdriver: false" in d.get("markdown", "") and d.get("metadata", {}).get("proxyUsed") == "stealth", b.get("error", ""))

s, b = scrape({"url": SITE + "/", "formats": ["branding"]}); br = b.get("data", {}).get("branding") or {}
check("branding", bool(br.get("colors")) and bool(br.get("fonts")), b.get("error", "") or list(br.keys())[:6])

s, b = scrape({"url": SITE + "/about/", "formats": [{"type": "focus", "query": "about", "maxTokens": 200}]})
f = b.get("data", {}).get("focus") or {}
check("focus", s == 200 and f.get("estimatedTokens", 10**9) <= 200 and f.get("sourceEstimatedTokens", 0) > 0, b.get("error", "") or f.get("estimatedTokens"))

tag = f"e2e-{int(time.time())}"
ct = {"url": SITE + "/about/", "formats": ["markdown", {"type": "changeTracking", "tag": tag}]}
s, b = scrape(ct); c1 = b.get("data", {}).get("changeTracking") or {}
s, b = scrape(ct); c2 = b.get("data", {}).get("changeTracking") or {}
check("changeTracking new->same", c1.get("changeStatus") == "new" and c2.get("changeStatus") == "same"
      and c1.get("snapshotId") == c2.get("snapshotId"), (c1, c2))
s, b = call("GET", f"/v2/snapshots?url={urllib.request.quote(SITE + '/about/', safe='')}&tag={tag}")
snaps = b.get("snapshots", [])
check("snapshots list", s == 200 and len(snaps) == 1 and snaps[0]["id"] == c1.get("snapshotId"), s)
if snaps:
    s, b = call("GET", f"/v2/snapshots/{snaps[0]['id']}")
    check("snapshot read", s == 200 and len(b.get("snapshot", {}).get("markdown", "")) > 0, s)

u = f"{SITE}/blog/?e2e={int(time.time())}"
s, b = scrape({"url": u, "maxAge": 600000}); m1 = b.get("data", {}).get("metadata", {})
s, b = scrape({"url": u, "maxAge": 600000}); m2 = b.get("data", {}).get("metadata", {})
check("cache miss->hit", m1.get("cacheState") == "miss" and m2.get("cacheState") == "hit", (m1.get("cacheState"), m2.get("cacheState")))

if len(sys.argv) > 3:
    with open(sys.argv[3], "w") as out:
        json.dump(results, out)
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
