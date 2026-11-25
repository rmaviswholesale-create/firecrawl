from typing import Any, Dict, List
from urllib.parse import quote

from ...utils.error_handler import FirecrawlError, handle_response_error
from ...utils.http_client_async import AsyncHttpClient


def _check_ok(response: Any, action: str) -> Dict[str, Any]:
    if response.status_code >= 400:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error occurred"))
    return body


async def list_profiles(client: AsyncHttpClient) -> List[Dict[str, Any]]:
    response = await client.get("/v2/profiles")
    body = _check_ok(response, "list profiles")
    return body["profiles"]


async def get_profile(client: AsyncHttpClient, name: str) -> Dict[str, Any]:
    response = await client.get(f"/v2/profiles/{quote(name, safe='')}")
    body = _check_ok(response, "get profile")
    return body["profile"]


async def delete_profile(client: AsyncHttpClient, name: str) -> Dict[str, Any]:
    response = await client.delete(f"/v2/profiles/{quote(name, safe='')}")
    _check_ok(response, "delete profile")
    return {"success": True}
