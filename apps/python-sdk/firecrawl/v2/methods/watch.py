from typing import Any, Dict, List, Optional
from urllib.parse import quote

from ..utils import FirecrawlError, HttpClient, handle_response_error


def _check_ok(response: Any, action: str) -> Dict[str, Any]:
    if not response.ok:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error occurred"))
    return body


def create_watch(client: HttpClient, request: Dict[str, Any]) -> Dict[str, Any]:
    response = client.post("/v2/watch", request)
    body = _check_ok(response, "create watch")
    return body["watch"]


def list_watches(client: HttpClient) -> List[Dict[str, Any]]:
    response = client.get("/v2/watch")
    body = _check_ok(response, "list watches")
    return body["watches"]


def get_watch(client: HttpClient, watch_id: str) -> Dict[str, Any]:
    response = client.get(f"/v2/watch/{quote(watch_id, safe='')}")
    body = _check_ok(response, "get watch")
    return body["watch"]


def update_watch(
    client: HttpClient, watch_id: str, request: Dict[str, Any]
) -> Dict[str, Any]:
    response = client.patch(f"/v2/watch/{quote(watch_id, safe='')}", request)
    body = _check_ok(response, "update watch")
    return body["watch"]


def delete_watch(client: HttpClient, watch_id: str) -> Dict[str, Any]:
    response = client.delete(f"/v2/watch/{quote(watch_id, safe='')}")
    _check_ok(response, "delete watch")
    return {"success": True}


def run_watch(client: HttpClient, watch_id: str) -> Dict[str, Any]:
    response = client.post(f"/v2/watch/{quote(watch_id, safe='')}/run", {})
    body = _check_ok(response, "run watch")
    return body["run"]


def list_watch_runs(
    client: HttpClient, watch_id: str, limit: Optional[int] = None
) -> List[Dict[str, Any]]:
    query = f"?limit={limit}" if limit is not None else ""
    response = client.get(f"/v2/watch/{quote(watch_id, safe='')}/runs{query}")
    body = _check_ok(response, "list watch runs")
    return body["runs"]
