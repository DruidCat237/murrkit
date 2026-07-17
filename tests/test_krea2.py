"""Pure-logic tests for the Krea 2 Turbo bridge (tools/kitty_api.py):
input builder validation, result-URL extraction shapes, batch pricing."""

from __future__ import annotations

import pytest

from tools import kitty_api as k

# ---- build_krea2_input ---------------------------------------------------------


def test_input_defaults_to_moebius_at_0_8() -> None:
    inp = k.build_krea2_input("a piebald cat police officer")
    assert inp["lora_preset"] == "moebius"
    assert inp["lora_preset_strength"] == 0.8
    # The worker needs the page's verbose label — bare "1:1" produced 16:9
    # in the live probe, so the builder must translate.
    assert inp["aspect_ratio"] == "1:1 (Square)"
    assert isinstance(inp["seed"], int)
    assert inp["prompt"].startswith("a piebald")


def test_input_accepts_verbose_aspect_passthrough() -> None:
    inp = k.build_krea2_input("x", aspect_ratio="9:16 (Portrait Widescreen)")
    assert inp["aspect_ratio"] == "9:16 (Portrait Widescreen)"


def test_input_rejects_empty_prompt_and_unknown_preset() -> None:
    with pytest.raises(ValueError, match="prompt is empty"):
        k.build_krea2_input("   ")
    with pytest.raises(ValueError, match="unknown lora_preset"):
        k.build_krea2_input("x", lora_preset="not-a-preset")
    with pytest.raises(ValueError, match="aspect_ratio"):
        k.build_krea2_input("x", aspect_ratio="7:3")


def test_input_clamps_strength_to_page_slider() -> None:
    assert k.build_krea2_input("x", lora_preset_strength=9.0)["lora_preset_strength"] == k.KREA2_STRENGTH_MAX
    assert k.build_krea2_input("x", lora_preset_strength=-1)["lora_preset_strength"] == 0.0


def test_input_seed_is_deterministic_when_given() -> None:
    assert k.build_krea2_input("x", seed=42)["seed"] == 42


def test_all_page_presets_are_known() -> None:
    # Mirrors the krea2-turbo page dropdown (incl. the chosen moebius).
    for preset in ("realism-v2", "ultrareal", "fire-and-ice", "retro-anime",
                   "flat-illustration", "moebius", "retro-vintage-photo", "none"):
        assert preset in k.KREA2_LORA_PRESETS


# ---- extract_krea2_urls ----------------------------------------------------------


def test_extract_output_outputs_url() -> None:
    data = {"output": {"outputs": [{"url": "https://cdn/x.png"}, {"url": "https://cdn/y.png"}]}}
    assert k.extract_krea2_urls(data) == ["https://cdn/x.png", "https://cdn/y.png"]


def test_extract_s3_key_maps_to_media_endpoint() -> None:
    data = {"outputs": [{"s3_key": "results/a b.png"}]}
    urls = k.extract_krea2_urls(data)
    assert len(urls) == 1
    assert urls[0].startswith(f"{k.KITTY_BASE}/media?key=results/")
    assert "a%20b.png" in urls[0]
    assert urls[0].endswith("&endpoint=1")


def test_extract_falls_back_to_plugin_normalized_shape() -> None:
    data = {"output": {"imageURL": "https://cdn/z.png"}}
    assert k.extract_krea2_urls(data) == ["https://cdn/z.png"]


def test_extract_raises_on_empty_payload() -> None:
    with pytest.raises(k.KittyApiError):
        k.extract_krea2_urls({"output": {}})


# ---- pricing ----------------------------------------------------------------------


def test_krea2_pricing_matches_site_tiers() -> None:
    # Site: [1 => 16, 2 => 32, 4 => 56, 8 => 96, 16 => 160] cents.
    def cents(n: int) -> int:
        return k.estimate_cost_cents(workflow_id="krea2-turbo", batch=n)

    assert cents(1) == 16
    assert cents(2) == 32
    assert cents(4) == 56
    assert cents(8) == 96
    assert cents(16) == 160
    # Between tiers: per-image rate of the best reached tier.
    assert cents(3) == 3 * 16
    assert cents(5) == 5 * 14


def test_batch_param_does_not_change_other_workflows() -> None:
    a = k.estimate_cost_cents(workflow_id="gpt-image-2", quality="high", resolution="2K")
    b = k.estimate_cost_cents(workflow_id="gpt-image-2", quality="high", resolution="2K", batch=16)
    assert a == b
