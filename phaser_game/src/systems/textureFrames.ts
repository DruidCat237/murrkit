import Phaser from "phaser";
import type { AssetRef } from "@/builders/levelSpec";

/**
 * Slice a sub-frame out of a multi-frame PNG that was loaded as a plain image.
 * Returns `{ key, frame }` ready for sprite construction / setTexture.
 *
 * We load atlases as plain images (BootScene) and slice on demand here so the
 * loader never needs to know frame dimensions up front. Idempotent — the frame
 * is registered on the texture once and reused.
 */
export function sliceFrame(
  scene: Phaser.Scene,
  ref: { key: string; framesX?: number; framesY?: number; frame?: number },
): { key: string; frame?: string } {
  const fx = ref.framesX ?? 1;
  const fy = ref.framesY ?? 1;
  if (fx <= 1 && fy <= 1) return { key: ref.key };
  const idx = ref.frame ?? 0;
  const frameKey = `f${idx}`;
  const tex = scene.textures.get(ref.key);
  if (!tex.has(frameKey)) {
    const src = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const w = ("naturalWidth" in src ? src.naturalWidth : src.width) || tex.source[0].width;
    const h = ("naturalHeight" in src ? src.naturalHeight : src.height) || tex.source[0].height;
    const fw = Math.floor(w / fx);
    const fh = Math.floor(h / fy);
    const col = idx % fx;
    const row = Math.floor(idx / fx);
    tex.add(frameKey, 0, col * fw, row * fh, fw, fh);
  }
  return { key: ref.key, frame: frameKey };
}

/** Convenience for an AssetRef + explicit frame override. */
export function frameOf(scene: Phaser.Scene, ref: AssetRef, frame: number): string | undefined {
  return sliceFrame(scene, { ...ref, frame }).frame;
}
