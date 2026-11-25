from typing import Any, Dict, List
from urllib.parse import quote

from ..utils import FirecrawlError, HttpClient, handle_response_error


def _check_ok(response: Any, action: str) -> Dict[str, Any]:
    if not response.ok:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error occurred"))
    return body


def list_profiles(client: HttpClient) -> List[Dict[str, Any]]:
    response = client.get("/v2/profiles")
    body = _check_ok(response, "list profiles")
    return body["profiles"]


def get_profile(client: HttpClient, name: str) -> Dict[str, Any]:
    response = client.get(f"/v2/profiles/{quote(name, safe='')}")
    body = _check_ok(response, "get profile")
    return body["profile"]


def delete_profile(client: HttpClient, name: str) -> Dict[str, Any]:
    response = client.delete(f"/v2/profiles/{quote(name, safe='')}")
    _check_ok(response, "delete profile")
    return {"success": True}
