from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode

from ...utils.error_handler import FirecrawlError, handle_response_error
from ...utils.http_client_async import AsyncHttpClient


def _check_ok(response: Any, action: str) -> Dict[str, Any]:
    if response.status_code >= 400:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error occurred"))
    return body


async def create_watch(
    client: AsyncHttpClient, request: Dict[str, Any]
) -> Dict[str, Any]:
    response = await client.post("/v2/watch", request)
    body = _check_ok(response, "create watch")
    return body["watch"]


async def list_watches(client: AsyncHttpClient) -> List[Dict[str, Any]]:
    response = await client.get("/v2/watch")
    body = _check_ok(response, "list watches")
    return body["watches"]


async def get_watch(client: AsyncHttpClient, watch_id: str) -> Dict[str, Any]:
    response = await client.get(f"/v2/watch/{quote(watch_id, safe='')}")
    body = _check_ok(response, "get watch")
    return body["watch"]


async def update_watch(
    client: AsyncHttpClient, watch_id: str, request: Dict[str, Any]
) -> Dict[str, Any]:
    response = await client.patch(f"/v2/watch/{quote(watch_id, safe='')}", request)
    body = _check_ok(response, "update watch")
    return body["watch"]


async def delete_watch(client: AsyncHttpClient, watch_id: str) -> Dict[str, Any]:
    response = await client.delete(f"/v2/watch/{quote(watch_id, safe='')}")
    _check_ok(response, "delete watch")
    return {"success": True}


async def run_watch(client: AsyncHttpClient, watch_id: str) -> Dict[str, Any]:
    response = await client.post(f"/v2/watch/{quote(watch_id, safe='')}/run", {})
    body = _check_ok(response, "run watch")
    return body["run"]


async def list_watch_runs(
    client: AsyncHttpClient, watch_id: str, limit: Optional[int] = None
) -> List[Dict[str, Any]]:
    query = f"?{urlencode({'limit': limit})}" if limit is not None else ""
    response = await client.get(f"/v2/watch/{quote(watch_id, safe='')}/runs{query}")
    body = _check_ok(response, "list watch runs")
    return body["runs"]
