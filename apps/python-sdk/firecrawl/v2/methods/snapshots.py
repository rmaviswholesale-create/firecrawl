from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode

from ..utils import FirecrawlError, HttpClient, handle_response_error


def _check_ok(response: Any, action: str) -> Dict[str, Any]:
    if not response.ok:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error occurred"))
    return body


def list_snapshots(
    client: HttpClient,
    url: str,
    tag: Optional[str] = None,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    params: Dict[str, Any] = {"url": url}
    if tag is not None:
        params["tag"] = tag
    if limit is not None:
        params["limit"] = limit
    response = client.get(f"/v2/snapshots?{urlencode(params)}")
    body = _check_ok(response, "list snapshots")
    return body["snapshots"]


def get_snapshot(client: HttpClient, snapshot_id: str) -> Dict[str, Any]:
    response = client.get(f"/v2/snapshots/{quote(snapshot_id, safe='')}")
    body = _check_ok(response, "get snapshot")
    return body["snapshot"]


def diff_snapshots(
    client: HttpClient, from_id: str, to_id: str
) -> Dict[str, Any]:
    query = urlencode({"from": from_id, "to": to_id})
    response = client.get(f"/v2/snapshots/diff?{query}")
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
