# Self-hosting Firecrawl

Want to get Firecrawl running? Start with the
[Firecrawl self-hosting guide](https://docs.firecrawl.dev/contributing/self-host).
It takes you from checkout to a successful scrape with Docker Compose.

Use this file when you are changing the baseline. It stays with the source, so
the services and configuration match the revision you checked out.

## Pick the guide for the job

| If you need to decide or do this | Start here |
| --- | --- |
| Decide whether self-hosting fits and run the first scrape | [Public self-hosting guide](https://docs.firecrawl.dev/contributing/self-host) |
| Check which variables and services exist at this revision | [Root Compose configuration](./docker-compose.yaml) |
| Adapt a Kubernetes deployment | [Kubernetes manifests](./examples/kubernetes/cluster-install/) or [Helm chart](./examples/kubernetes/firecrawl-helm/) |
| Change Firecrawl product code | [Running Locally](https://docs.firecrawl.dev/contributing/guide), then the [contribution guide](./CONTRIBUTING.md) |
| Connect an agent or terminal client | [Local MCP](https://docs.firecrawl.dev/mcp-server/local) or [Firecrawl CLI](https://docs.firecrawl.dev/sdks/cli#connect-the-cli-to-self-hosted-firecrawl) |

## Keep the first run simple

- **Release: an exact tag.** Review the target release's Compose file before
  changing it. A checkout of `main` and floating image tags can change
  independently.
- **API authentication: `USE_DB_AUTHENTICATION=false`.** Set
  `SELF_HOSTED_API_KEYS` to require a key on every request (see
  [API keys](#api-keys)). `USE_DB_AUTHENTICATION=true` is a different thing:
  it expects the hosted database schema and application configuration, and
  changing that variable alone is not a complete authenticated deployment.
- **Queue: NuQ PostgreSQL.** Keep it unless you intentionally set
  `NUQ_BACKEND=fdb` and are prepared to operate FoundationDB.
- **Scraping: bundled Playwright with basic fetch fallback.** Connect and
  configure a separate engine such as Fire-engine only when you need it.
- **AI-backed features: no model provider.** Connect OpenAI, an OpenAI-compatible
  endpoint, or Ollama when a feature needs it.
- **Queue administration UI: off.** Enable it only with a strong
  `BULL_AUTH_KEY` and restricted network access.

Get this baseline working before swapping backends or adding providers.

The root `.env` overrides only variables referenced by `docker-compose.yaml`.
Do not use `apps/api/.env.example` as a drop-in Compose contract.

## What the stack runs

At this revision, Compose runs the Firecrawl API and workers, Playwright, Redis,
RabbitMQ, NuQ PostgreSQL, and FoundationDB services for the optional queue
backend. Only the API is published to the host by default, on port `3002`.

Self-hosting gives you source and infrastructure control. You also own
security, availability, capacity, upgrades, data retention, and compliance.

## Before production

- **If the API will leave a trusted network,** set `SELF_HOSTED_API_KEYS`
  and add TLS termination and network policy first. The default API is
  unauthenticated.
- **If data must survive service replacement,** test backups and recovery.
  The root Compose file keeps Redis (append-only file) and NuQ PostgreSQL on
  named volumes, `redis-data` and `nuq-postgres-data`; RabbitMQ has none.
  `docker compose down -v` deletes them.
- **If you change the PostgreSQL settings,** keep the API and database values
  consistent. At this revision, the bundled `pg_cron` configuration targets
  the default `postgres` database.
- **If you publish dependency ports,** secure them explicitly. PostgreSQL,
  Redis, RabbitMQ, and worker ports should remain private by default.
- **If you have availability or scale targets,** define monitoring, resource
  limits, scaling triggers, and upgrade and rollback procedures. The checked-in
  Compose file is a source-aligned starting point, not a production
  architecture.

Treat the Kubernetes and Helm examples as versioned starting points, not as
evidence that these production decisions have been made for you.

## Self-hosted engine features

These work on the bundled Playwright service and Redis, with no Fire-engine,
Bigtable, GCS or model provider.

### Actions, screenshots and mobile

`actions`, the `screenshot` format and `mobile: true` run on the Playwright
service. Screenshots and action PDFs come back inline as `data:` URLs.

```bash
curl -s localhost:3002/v2/scrape -H 'Content-Type: application/json' -d '{
  "url": "https://example.com",
  "formats": ["markdown", {"type": "screenshot", "fullPage": true}],
  "actions": [
    {"type": "click", "selector": "a"},
    {"type": "wait", "milliseconds": 500},
    {"type": "executeJavascript", "script": "document.title"}
  ]
}'
```

An action that cannot complete fails the scrape with `SCRAPE_ACTION_ERROR`.
A scrape may include at most 10 screenshot or PDF steps. A page or script
that never returns is cut off shortly after the request's `timeout`, capped by
`MAX_SCRAPE_TIMEOUT_MS` on the Playwright service (default `300000`).
Without a Playwright service, actions are rejected and screenshots are
unavailable.

### Location, stealth and branding

These also run on the Playwright service.

- `location: {"country": "DE"}` makes the browser present as a visitor from
  that country: `Accept-Language`, `navigator.language` and the timezone.
  It does not change the IP address the request comes from; for that, set
  `PROXY_SERVER` to a proxy in the country. `location.languages` overrides
  the language list.
- `proxy: "stealth"` (or `"enhanced"`) hides the markers headless Chromium
  exposes (`navigator.webdriver`, the user agent, plugins, WebGL vendor) and
  reports `metadata.proxyUsed: "stealth"`. If `STEALTH_PROXY_SERVER` is set,
  those scrapes also go out through it, so a residential proxy can be kept
  for the pages that need one. This defeats simple bot checks. It does not
  defeat checks that score IP reputation or behaviour, and it does not solve
  CAPTCHAs.
- The `branding` format returns colors, fonts and logo candidates. With no
  model provider configured it uses heuristics only.

| Variable (playwright-service) | Effect |
| --- | --- |
| `STEALTH_PROXY_SERVER` | Upstream proxy for stealth scrapes only. |
| `STEALTH_PROXY_USERNAME`, `STEALTH_PROXY_PASSWORD` | Its credentials. |

### Network capture (`network` format)

Returns the API calls the page made while loading and while actions ran, with
parsed JSON bodies, in `data.network.requests`.

```bash
curl -s localhost:3002/v2/scrape -H 'Content-Type: application/json' -d '{
  "url": "https://example.com",
  "formats": [{"type": "network", "urlPattern": "/api/"}],
  "waitFor": 2000
}'
```

| Option | Default | Effect |
| --- | --- | --- |
| `resourceTypes` | `["xhr", "fetch"]` | Request kinds to record. |
| `urlPattern` | unset | Text a request URL must contain; `*` matches any run of characters. Not a regular expression. |
| `includeBodies` | `true` | Include response bodies. |
| `maxRequests` | `50` | Requests kept; `network.truncated` reports overflow. |
| `maxBodyBytes` | `262144` | Larger bodies are cut and marked `truncated`. |

Captured bodies can hold whatever the page's own API returned, including
session-specific data. Without a Playwright service the scrape still succeeds
and carries a warning instead of `network`.

### Change tracking and snapshots

The `changeTracking` format stores page versions in Redis when
`USE_DB_AUTHENTICATION` is off and Bigtable is not configured. Each distinct
version of a page is a snapshot.

`since` compares against the page as it was at a point in time instead of the
previous scrape. It takes an ISO 8601 timestamp or an age: `30m`, `24h`, `7d`,
`2w`. If history starts later than `since`, the oldest snapshot is used;
`changeTracking.comparedTo` says which one.

```bash
curl -s localhost:3002/v2/scrape -H 'Content-Type: application/json' -d '{
  "url": "https://example.com/pricing",
  "formats": ["markdown", {"type": "changeTracking", "modes": ["git-diff"], "since": "7d"}]
}'
```

| Route | Returns |
| --- | --- |
| `GET /v2/snapshots?url=<url>&tag=<tag>&limit=<n>` | Saved versions of a page, newest first. |
| `GET /v2/snapshots/<id>` | One version with its markdown. |
| `GET /v2/snapshots/diff?from=<id>&to=<id>` | Diff between two versions. |

| Variable | Default | Effect |
| --- | --- | --- |
| `SNAPSHOT_STORE_ENABLED` | on without DB auth and Bigtable | Forces the store on or off. |
| `SNAPSHOT_HISTORY_LIMIT` | `30` | Versions kept per page and tag. |
| `SNAPSHOT_TTL_DAYS` | `90` | Days a page's history survives without a new scrape; `0` keeps it. |

History lives in Redis, which the root Compose file keeps on the `redis-data`
volume.

### Watches

A watch re-scrapes a URL on a schedule and calls a webhook when the page
changes. It uses the snapshot store above, so it needs no model, no extra
database and no Supabase.

```bash
curl -s localhost:3002/v2/watch -H 'Content-Type: application/json' -d '{
  "url": "https://example.com/pricing",
  "schedule": {"cron": "0 * * * *", "timezone": "America/New_York"},
  "webhook": {"url": "https://hooks.example.com/pricing", "secret": "s3cret"}
}'
```

`schedule` is either `{"cron": "...", "timezone": "..."}` (five-field cron,
timezone defaults to `UTC`) or `{"everySeconds": 3600}`.

`notifyOn` chooses which outcomes call the webhook: any of `new` (first
run), `same`, `changed`, `removed`. The default is `["changed", "removed"]`.

The webhook receives a JSON `POST`:

```json
{
  "type": "watch.changed",
  "watchId": "…",
  "runId": "…",
  "url": "https://example.com/pricing",
  "changeStatus": "changed",
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "snapshotId": "…",
  "comparedTo": { "snapshotId": "…", "capturedAt": "…" },
  "diff": "--- previous.md\n+++ current.md\n…"
}
```

With a `secret`, each delivery carries
`X-Firecrawl-Signature: sha256=<HMAC-SHA256 of the raw body>`. The secret is
never returned by the API. `diff` is `null` when the diff is larger than
100,000 characters or too large to compute; fetch the two snapshots instead.

| Route | Does |
| --- | --- |
| `POST /v2/watch` | Create a watch. |
| `GET /v2/watch` | List watches. |
| `GET /v2/watch/<id>` | One watch, with `lastStatus` and `nextRunAt`. |
| `DELETE /v2/watch/<id>` | Delete it and its run history. |
| `POST /v2/watch/<id>/run` | Run it now and return the result. |
| `GET /v2/watch/<id>/runs` | Up to 50 recent runs, newest first. |

| Variable | Default | Effect |
| --- | --- | --- |
| `WATCH_POLL_INTERVAL_MS` | `15000` | How often the worker looks for due watches. |
| `WATCH_MIN_INTERVAL_SECONDS` | `60` | Shortest schedule allowed. |
| `WATCH_MAX_PER_TEAM` | `200` | Watches allowed. |

Limits to know:

- A failed webhook delivery is recorded on the run (`webhook.delivered:
  false`) and is not retried. The next change sends a new one.
- Runs missed while the stack was down are not replayed: a due watch runs
  once when the worker returns.
- Watches and run history live in Redis, like snapshots.
- A watch's baseline is a snapshot, so it expires with `SNAPSHOT_TTL_DAYS`.
  A watch that runs less often than that reports `new` every time.
- Webhooks to private addresses are refused unless `ALLOW_LOCAL_WEBHOOKS` is
  set.

### Focused markdown (`focus` format)

Returns the parts of the page that match a query, within a token budget, in
`data.focus.markdown`. Ranking is lexical (BM25) and runs in the API, so it
needs no model. It matches words, not meaning: a query that shares no terms
with the page returns empty markdown and a warning.

```bash
curl -s localhost:3002/v2/scrape -H 'Content-Type: application/json' -d '{
  "url": "https://example.com/docs",
  "formats": [{"type": "focus", "query": "rate limits per API key", "maxTokens": 800}]
}'
```

### Page cache

Set `LOCAL_CACHE_ENABLED=true` to keep scraped pages in Redis and serve
repeat scrapes of the same URL from there. A request's `maxAge` (milliseconds)
is the oldest copy it accepts; `maxAge: 0` always scrapes live, and
`storeInCache: false` keeps a scrape out of the cache.
`metadata.cacheState` is `hit` or `miss`, with `metadata.cachedAt` on a hit.

Requests with `actions`, custom `headers`, a `profile`, or the `screenshot`,
`network`, `changeTracking` or `branding` formats are never cached. Only
responses with a 2xx status are stored. `minAge` is not supported by this
cache.

| Variable | Default | Effect |
| --- | --- | --- |
| `LOCAL_CACHE_ENABLED` | off | Turns the cache on. |
| `LOCAL_CACHE_DEFAULT_MAX_AGE_MS` | `172800000` (2 days) | `maxAge` for requests that set none. `0` caches only when a request asks. |
| `LOCAL_CACHE_TTL_SECONDS` | `604800` (7 days) | How long Redis keeps a page. |
| `LOCAL_CACHE_MAX_BYTES` | `5242880` | Pages with larger HTML are not cached. |

With the default `maxAge`, turning the cache on means a repeat scrape can
return a copy up to two days old unless the request sets `maxAge`. The v1 API
applies its own default of four hours.

### Checking a deployment

[`examples/self-host-smoke/smoke.py`](./examples/self-host-smoke/smoke.py)
exercises every feature in this section against a running stack and exits
non-zero on any failure. Its docstring lists what the stack needs.

## API keys

Set `SELF_HOSTED_API_KEYS` to a comma-separated list of keys. Every request
must then send one as `Authorization: Bearer <key>`; anything else gets
`401`. Generate keys with `openssl rand -hex 32`.

```bash
SELF_HOSTED_API_KEYS=3f9c...e1,7ab2...9d docker compose up -d
curl -s localhost:3002/v2/scrape -H 'Authorization: Bearer 3f9c...e1' \
  -H 'Content-Type: application/json' -d '{"url": "https://example.com"}'
```

All keys share one team: every key can list, read and cancel every other
key's crawls and read its snapshots and cached pages, and there are no
per-key rate limits or credits. Give keys only to callers you would trust
with each other's data. To rotate, add the new key, move
callers over, then remove the old one and restart the API. The admin routes
below are separate and use `BULL_AUTH_KEY`. Keys travel in clear text unless
TLS terminates in front of the API.

`ALLOW_LOCAL_WEBHOOKS=true` does more than its name says: it also lets
scrapes reach private addresses, so any key holder could scrape
`http://redis:6379` or a cloud metadata endpoint through your deployment.
Leave it unset on anything exposed beyond a trusted network.

## Admin routes

The key-protected routes on the main API port, `/admin/ops/...` and
`/admin/<key>/...`, exist only when `BULL_AUTH_KEY` is set. The
internal listener is separate: it starts whenever `ADMIN_INTERNAL_PORT` is set
and needs no key. The root Compose file passes `BULL_AUTH_KEY` alone; set the
other variables in the API container's environment.

| Variable | Default | Effect |
| --- | --- | --- |
| `BULL_AUTH_KEY` | unset | Turns on the key-protected admin routes. Routes under `/admin/ops/` accept `Authorization: Bearer <BULL_AUTH_KEY>`. |
| `BULL_AUTH_KEY_PREVIOUS` | unset | A second accepted bearer value, so callers can move to a new key without downtime. Clear it once every caller sends the new key. |
| `BULL_AUTH_KEY_PATH_ROUTES` | `true` | Keeps the routes that take the key as a path segment, `/admin/<key>/...`, including the queue UI at `/admin/<key>/queues`. Set `false` once callers use `/admin/ops/` or the internal listener. |
| `ADMIN_INTERNAL_PORT` | unset | Starts a second listener on this port that serves the routes below with no key. Never publish this port. |
| `ADMIN_INTERNAL_HOST` | `localhost` | Address the internal listener binds to. Bind a wider address only behind a network policy that limits who can reach the port. |

Header-authenticated routes: `GET /admin/ops/redis-health`,
`POST /admin/ops/acuc-cache-clear`,
`POST /admin/ops/ip-restriction-cache-clear`,
`POST /admin/ops/key-restriction-cache-clear` and
`POST /admin/ops/concurrency-queue-backfill`.

Internal listener routes, none of which need a key: the queue UI at
`/admin/queues`; metrics at `GET /admin/metrics`, `GET /admin/nuq-metrics`,
`GET /admin/nuq-fdb-metrics` and `GET /admin/index-queue-prometheus`; and
`GET /admin/redis-health`, `GET /admin/feng-check`,
`GET /admin/precrawl` (queues a precrawl run), `POST /admin/fsearch` (runs a
search) and `POST /admin/crawl-monitor` (still requires an API key and credits).
Anyone who can reach the port can use them.

The `firecrawl_admin_path_route_requests_total` metric counts requests to the
`/admin/<key>/...` routes, so you can confirm nothing still uses them before
turning them off.

Stuck? Open a
[self-host issue template](https://github.com/firecrawl/firecrawl/issues/new?template=self_host_issue.md)
or join the [Firecrawl Discord community](https://discord.gg/firecrawl).
