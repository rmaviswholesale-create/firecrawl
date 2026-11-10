from firecrawl.v2.types import (
    ChangeTrackingFormat,
    Document,
    FocusFormat,
    NetworkFormat,
    ScrapeOptions,
)
from firecrawl.v2.utils.validation import prepare_scrape_options


def _formats(*formats):
    return prepare_scrape_options(ScrapeOptions(formats=list(formats)))["formats"]


def test_network_format_model_keeps_its_options():
    assert _formats(
        NetworkFormat(url_pattern="/api/", max_requests=10, include_bodies=False)
    ) == [
        {
            "type": "network",
            "urlPattern": "/api/",
            "maxRequests": 10,
            "includeBodies": False,
        }
    ]


def test_focus_format_model_keeps_its_options():
    assert _formats(FocusFormat(query="refund policy", max_tokens=500)) == [
        {"type": "focus", "query": "refund policy", "maxTokens": 500}
    ]


def test_option_format_dicts_accept_snake_case_keys():
    assert _formats(
        {"type": "focus", "query": "pricing", "max_tokens": 300},
        {"type": "network", "resource_types": ["xhr"]},
    ) == [
        {"type": "focus", "query": "pricing", "maxTokens": 300},
        {"type": "network", "resourceTypes": ["xhr"]},
    ]


def test_plain_network_string_is_accepted():
    assert _formats("markdown", "network") == ["markdown", "network"]


def test_change_tracking_since_is_sent():
    assert _formats(
        "markdown", ChangeTrackingFormat(modes=["git-diff"], since="7d")
    ) == ["markdown", {"type": "changeTracking", "modes": ["git-diff"], "since": "7d"}]


def test_document_exposes_network_and_focus():
    doc = Document(
        network={"requests": [], "total": 0, "truncated": False},
        focus={"query": "q", "markdown": "m"},
    )
    assert doc.network["total"] == 0
    assert doc.focus["markdown"] == "m"
