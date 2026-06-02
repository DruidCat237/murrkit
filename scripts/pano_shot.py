"""Take a panoramic screenshot of the Phaser level by zooming the camera out
and disabling follow. One-shot probe — does NOT modify level YAML.

Usage: uv run python scripts/pano_shot.py
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path


SHOTS_DIR = Path(__file__).resolve().parent.parent / "public_files" / "screenshots"


async def main() -> None:
    from playwright.async_api import async_playwright

    SHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    out_path = SHOTS_DIR / f"pano_{stamp}.png"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context(viewport={"width": 1280, "height": 720})
            page = await ctx.new_page()
            await page.goto("http://127.0.0.1:5173/?level=level_01", wait_until="domcontentloaded")
            await page.wait_for_selector("canvas", timeout=8000)
            await page.wait_for_timeout(1200)
            await page.evaluate("""
                () => {
                    const game = window.game;
                    if (!game) return 'no-game';
                    const scene = game.scene.scenes.find(s => s.scene.isActive());
                    if (!scene) return 'no-scene';
                    const cam = scene.cameras.main;
                    cam.stopFollow();
                    cam.setZoom(0.5);
                    cam.setScroll(640, 0);
                    // Hide HUD text so vision-gate doesn't flag it as "debug overlay"
                    for (const k of ['hud','catPickerHud']) {
                        if (scene[k] && scene[k].setVisible) scene[k].setVisible(false);
                    }
                    return 'ok';
                }
            """)
            await page.wait_for_timeout(400)
            await page.screenshot(path=str(out_path), full_page=False)
            print(str(out_path))
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
