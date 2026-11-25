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


async def list_snapshots(
    client: AsyncHttpClient,
    url: str,
    tag: Optional[str] = None,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    params: Dict[str, Any] = {"url": url}
    if tag is not None:
        params["tag"] = tag
    if limit is not None:
        params["limit"] = limit
    response = await client.get(f"/v2/snapshots?{urlencode(params)}")
    body = _check_ok(response, "list snapshots")
    return body["snapshots"]


async def get_snapshot(client: AsyncHttpClient, snapshot_id: str) -> Dict[str, Any]:
    response = await client.get(f"/v2/snapshots/{quote(snapshot_id, safe='')}")
    body = _check_ok(response, "get snapshot")
    return body["snapshot"]


async def diff_snapshots(
    client: AsyncHttpClient, from_id: str, to_id: str
) -> Dict[str, Any]:
    query = urlencode({"from": from_id, "to": to_id})
    response = await client.get(f"/v2/snapshots/diff?{query}")
    body = _check_ok(response, "diff snapshots")
    result: Dict[str, Any] = {
        "changeStatus": body["changeStatus"],
        "from": body["from"],
        "to": body["to"],
    }
    if "diff" in body:
        result["diff"] = body["diff"]
    if "diffOmitted" in body:
        result["diffOmitted"] = body["diffOmitted"]
    return result
