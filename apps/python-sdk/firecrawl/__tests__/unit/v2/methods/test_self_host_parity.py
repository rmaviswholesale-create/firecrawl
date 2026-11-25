from unittest.mock import AsyncMock, MagicMock
import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient


def _resp(payload, ok=True, status_code=200):
    r = MagicMock()
    r.ok = ok
    r.status_code = status_code
    r.json.return_value = payload
    return r


def test_sync_watch_profiles_snapshots():
    client = FirecrawlClient(api_key="fc-test", api_url="https://api.example.com")
    watch = {"id": "w-1", "url": "https://example.com"}
    run = {"id": "r-1", "changeStatus": "new"}
    profile = {"name": "p1", "cookieCount": 2, "originCount": 1}
    snap = {"id": "s1", "url": "https://example.com", "markdown": "# hi"}

    client.http_client.post = MagicMock(
        side_effect=lambda path, *_a, **_kw: _resp(
            {"success": True, "watch": watch} if path == "/v2/watch" else {"success": True, "run": run}
        )
    )
    client.http_client.patch = MagicMock(
        return_value=_resp({"success": True, "watch": {**watch, "enabled": False}})
    )
    client.http_client.delete = MagicMock(return_value=_resp({"success": True}))
    client.http_client.get = MagicMock(
        side_effect=lambda path, *_a, **_kw: _resp(
            {"success": True, "watches": [watch]}
            if path == "/v2/watch"
            else {"success": True, "runs": [run]}
            if path.endswith("/runs?limit=5")
            else {"success": True, "watch": watch}
            if path.startswith("/v2/watch/")
            else {"success": True, "profiles": [profile]}
            if path == "/v2/profiles"
            else {"success": True, "profile": profile}
            if path.startswith("/v2/profiles/")
            else {"success": True, "changeStatus": "changed", "from": snap, "to": snap}
            if path.startswith("/v2/snapshots/diff")
            else {"success": True, "snapshots": [snap]}
            if path.startswith("/v2/snapshots?")
            else {"success": True, "snapshot": snap}
        )
    )

    assert client.create_watch({"url": "https://example.com", "schedule": {"cron": "0 3 * * *"}}) == watch
    assert client.list_watches() == [watch]
    assert client.get_watch("w-1") == watch
    assert client.update_watch("w-1", {"enabled": False})["enabled"] is False
    assert client.run_watch("w-1") == run
    assert client.list_watch_runs("w-1", limit=5) == [run]
    assert client.delete_watch("w-1") == {"success": True}

    assert client.list_profiles() == [profile]
    assert client.get_profile("p1") == profile
    assert client.delete_profile("p1") == {"success": True}

    assert client.list_snapshots("https://example.com", limit=10) == [snap]
    assert client.get_snapshot("s1") == snap
    assert client.diff_snapshots("s1", "s2")["changeStatus"] == "changed"


@pytest.mark.asyncio
async def test_async_watch_profiles_snapshots():
    client = AsyncFirecrawlClient(api_key="fc-test", api_url="https://api.example.com")
    watch = {"id": "w-1", "url": "https://example.com"}
    run = {"id": "r-1", "changeStatus": "new"}
    profile = {"name": "p1", "cookieCount": 2, "originCount": 1}
    snap = {"id": "s1", "url": "https://example.com", "markdown": "# hi"}

    client.async_http_client.post = AsyncMock(
        side_effect=lambda path, *_a, **_kw: _resp(
            {"success": True, "watch": watch} if path == "/v2/watch" else {"success": True, "run": run}
        )
    )
    client.async_http_client.patch = AsyncMock(
        return_value=_resp({"success": True, "watch": {**watch, "enabled": False}})
    )
    client.async_http_client.delete = AsyncMock(return_value=_resp({"success": True}))
    client.async_http_client.get = AsyncMock(
        side_effect=lambda path, *_a, **_kw: _resp(
            {"success": True, "watches": [watch]}
            if path == "/v2/watch"
            else {"success": True, "runs": [run]}
            if path.endswith("/runs?limit=5")
            else {"success": True, "watch": watch}
            if path.startswith("/v2/watch/")
            else {"success": True, "profiles": [profile]}
            if path == "/v2/profiles"
            else {"success": True, "profile": profile}
            if path.startswith("/v2/profiles/")
            else {"success": True, "changeStatus": "changed", "from": snap, "to": snap}
            if path.startswith("/v2/snapshots/diff")
            else {"success": True, "snapshots": [snap]}
            if path.startswith("/v2/snapshots?")
            else {"success": True, "snapshot": snap}
        )
    )

    assert await client.create_watch({"url": "https://example.com", "schedule": {"cron": "0 3 * * *"}}) == watch
    assert await client.list_watches() == [watch]
    assert await client.get_watch("w-1") == watch
    assert (await client.update_watch("w-1", {"enabled": False}))["enabled"] is False
    assert await client.run_watch("w-1") == run
    assert await client.list_watch_runs("w-1", limit=5) == [run]
    assert await client.delete_watch("w-1") == {"success": True}

    assert await client.list_profiles() == [profile]
    assert await client.get_profile("p1") == profile
    assert await client.delete_profile("p1") == {"success": True}

    assert await client.list_snapshots("https://example.com", limit=10) == [snap]
    assert await client.get_snapshot("s1") == snap
    assert (await client.diff_snapshots("s1", "s2"))["changeStatus"] == "changed"
