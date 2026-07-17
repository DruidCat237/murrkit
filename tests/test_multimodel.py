"""Pure-logic tests for the multi-image-model support (no network).

Covers the nano-banana-2 input builder, the IMAGE_MODELS registry (incl. that
the retired nano-banana-pro is absent), the general-workflow resolver, and
nano-banana-2 pricing. Mirrors the tests/test_krea2.py style.
"""
from __future__ import annotations

import pytest

from tools import kitty_api as k


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

def test_registry_has_live_models() -> None:
    assert k.WORKFLOW_GPT_IMAGE_2 in k.IMAGE_MODELS
    assert k.WORKFLOW_NANO_BANANA_2 in k.IMAGE_MODELS
    assert k.WORKFLOW_KREA2_TURBO in k.IMAGE_MODELS


def test_registry_omits_retired_nano_banana_pro() -> None:
    # nano-banana-pro was retired on the Kitty backend — it must not be
    # offered anywhere (no constant, no registry entry).
    assert not hasattr(k, "WORKFLOW_NANO_BANANA_PRO")
    assert "nano-banana-pro" not in k.IMAGE_MODELS


def test_nano_banana_is_both_kind() -> None:
    assert k.IMAGE_MODELS[k.WORKFLOW_NANO_BANANA_2]["kind"] == "both"
    # No quality knob — price is flat per resolution.
    assert k.IMAGE_MODELS[k.WORKFLOW_NANO_BANANA_2]["quality"] is False


# --------------------------------------------------------------------------
# resolve_image_workflow
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "value,expected",
    [
        ("gpt-image-2", "gpt-image-2"),
        ("nano-banana-2", "nano-banana-2"),
        ("NANO-BANANA-2", "nano-banana-2"),   # case-insensitive
        (None, "gpt-image-2"),                 # None → default
        ("", "gpt-image-2"),                   # empty → default
        ("krea2-turbo", "gpt-image-2"),        # not a general workflow → default
        ("gpt-image-2-edit", "gpt-image-2"),   # edit needs a ref → default
        ("bogus", "gpt-image-2"),              # unknown → default
    ],
)
def test_resolve_image_workflow(value: str | None, expected: str) -> None:
    assert k.resolve_image_workflow(value) == expected


def test_resolve_image_workflow_custom_default() -> None:
    # An unknown value falls back to the provided default, not always gpt.
    assert k.resolve_image_workflow("bogus", default="nano-banana-2") == "nano-banana-2"


# --------------------------------------------------------------------------
# build_nano_banana_input
# --------------------------------------------------------------------------

def test_nano_input_text_only_omits_image_urls() -> None:
    inp = k.build_nano_banana_input("a red barrel", aspect_ratio="1:1", resolution="1K")
    assert inp == {
        "mode": "edit",
        "prompt": "a red barrel",
        "aspect_ratio": "1:1",
        "resolution": "1K",
    }
    assert "image_urls" not in inp


def test_nano_input_with_reference_includes_image_urls() -> None:
    inp = k.build_nano_banana_input(
        "same style, blue barrel",
        aspect_ratio="16:9",
        resolution="2K",
        image_urls=["https://example.com/ref.png"],
    )
    assert inp["image_urls"] == ["https://example.com/ref.png"]
    assert inp["mode"] == "edit"


def test_nano_input_resolution_uppercased() -> None:
    inp = k.build_nano_banana_input("x", resolution="2k")
    assert inp["resolution"] == "2K"


def test_nano_input_rejects_empty_prompt() -> None:
    with pytest.raises(ValueError, match="prompt is empty"):
        k.build_nano_banana_input("   ")


def test_nano_input_rejects_bad_aspect() -> None:
    with pytest.raises(ValueError, match="aspect_ratio"):
        k.build_nano_banana_input("x", aspect_ratio="7:3")


def test_nano_input_rejects_bad_resolution() -> None:
    with pytest.raises(ValueError, match="resolution"):
        k.build_nano_banana_input("x", resolution="8K")


# --------------------------------------------------------------------------
# Pricing — nano-banana-2 is flat per resolution (matches the page: 20/30/40¢)
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "resolution,cents",
    [("1K", 20), ("2K", 30), ("4K", 40)],
)
def test_nano_banana_pricing(resolution: str, cents: int) -> None:
    assert k.estimate_cost_cents(
        workflow_id="nano-banana-2", resolution=resolution,
    ) == cents
