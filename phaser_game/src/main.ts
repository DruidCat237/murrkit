import Phaser from "phaser";
import { installUiCheck } from "@/systems/uiCheck";
import { GameScene } from "@/scenes/GameScene";
import { BootScene } from "@/scenes/BootScene";
import { RpgDemoScene } from "@/scenes/RpgDemoScene";
import { PlatformerScene } from "@/scenes/PlatformerScene";
import { TilemapScene } from "@/scenes/TilemapScene";
import { cartridgeScenes } from "@/cartridge";
import { hasMap } from "@/builders/mapRegistry";

const params = new URLSearchParams(window.location.search);
// Pick the scene to boot from `?level=…`. With no `?level` the engine lands on
// the slingshot example (BootScene → GameScene). Generated games reach their own
// scene via an explicit `?level=…`; the playtest/preview harness uses the same.
const levelId = params.get("level") || "slingshot";
if (params.get("debug") === "1") document.body.classList.add("debug");

// The data-driven RPG engine demo + the platformer example are standalone scenes.
const isRpgDemo = levelId === "rpg_demo";
const isPlatformer = levelId === "platformer";

// Expose game globally so Playwright / composition-check can introspect.
declare global {
  interface Window {
    game: Phaser.Game;
    levelId: string;
  }
}

// Automation (Playwright playtest/drive, any headless Chromium) must NEVER have
// its loop frozen — detect it so the visibility-pause below is skipped there.
const isAutomation =
  navigator.webdriver === true || /HeadlessChrome/i.test(navigator.userAgent);

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game-container",
  width: 1280,
  height: 720,
  backgroundColor: "#87CEEB",
  pixelArt: false,
  // Don't steal focus when embedded in the dashboard iframe / popout.
  autoFocus: false,
  // Cap the simulation at 60fps so a 120/144Hz display doesn't run physics +
  // render at 2–2.4× the rate a 2D game needs.
  fps: { target: 60, min: 30 },
  // Lean WebGL — a flat 2D game needs no antialiasing or the discrete GPU.
  render: {
    antialias: false,
    powerPreference: "low-power",
    desynchronized: true,
    failIfMajorPerformanceCaveat: false,
  },
  physics: {
    default: "arcade",
    arcade: { gravity: { x: 0, y: 900 }, debug: false },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // First scene in the list auto-starts. An external cartridge (git-ignored game
  // under src/cartridges/) wins by `?level=<id>`; then RPG demo + platformer run
  // solo; a bundled Map Studio map (`maps/<id>.map.yaml`) boots TilemapScene;
  // every other level boots the slingshot BootScene → GameScene pipeline.
  scene:
    cartridgeScenes(levelId) ??
    (isRpgDemo
      ? [RpgDemoScene]
      : isPlatformer
        ? [PlatformerScene]
        : hasMap(levelId)
          ? [TilemapScene]
          : [BootScene, GameScene]),
};

window.levelId = levelId;
window.game = new Phaser.Game(config);

// Deterministic UI-QA: window.__uiCheck() reports overlapping / off-screen text
// in any visible scene (used by POST /api/phaser/ui-check + the inner Claude).
installUiCheck();

// RESOURCE SAVER: fully halt the game loop (zero update, zero WebGL render) while
// the tab/window is hidden, and resume on return. Skipped under automation so
// playtests / live play never freeze on a page the headless browser reports hidden.
if (!isAutomation) {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.game.loop.sleep();
    else window.game.loop.wake();
  });
  // The dashboard embeds this game in an iframe inside a tabbed dock. An INACTIVE
  // tab is display:none, yet the iframe's own document still reports "visible", so
  // the host posts the panel's on-screen state (IntersectionObserver) — honour it.
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; visible?: boolean } | null;
    if (d && d.type === "phaser2d:visible") {
      if (d.visible) window.game.loop.wake();
      else window.game.loop.sleep();
    }
  });
}

document.getElementById("status-bar")!.textContent =
  `murrkit · level=${levelId} · phaser=${Phaser.VERSION}`;
