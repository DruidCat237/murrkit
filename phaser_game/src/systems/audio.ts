import Phaser from "phaser";

// Global audio manager — ONE owner of the single background-music instance + master mute +
// per-channel volumes (persisted). Phaser's SoundManager is global and does NOT stop sounds on
// scene change, which caused (a) two tracks overlapping after entering an arena and (b) music
// never stopping on navigation. Routing ALL music through this singleton fixes both by
// construction: playMusic() always stops the previous track first, so only one can ever play.

const LS = { music: "catvb_musicVol", sfx: "catvb_sfxVol" };

const isMusicKey = (k: string | undefined): boolean =>
  !!k && (k === "main_menu_music" || k.startsWith("music_"));

class AudioManager {
  musicVol = 0.2; // default music volume on a FRESH game (user: "domyślnie ustaw muzykę na 20%"); a saved catvb_musicVol overrides
  sfxVol = 0.8;
  muted = false;
  private music?: Phaser.Sound.BaseSound;
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    const m = parseFloat(localStorage.getItem(LS.music) ?? "");
    if (!Number.isNaN(m)) this.musicVol = Phaser.Math.Clamp(m, 0, 1);
    const s = parseFloat(localStorage.getItem(LS.sfx) ?? "");
    if (!Number.isNaN(s)) this.sfxVol = Phaser.Math.Clamp(s, 0, 1);
    // mute is SESSION-ONLY (never read from storage) — a persisted mute once locked the whole
    // app silent with no menu unmute (user: "sound zniknął mi całkiem"). Every load starts unmuted.
    this.muted = false;
    localStorage.removeItem("catvb_muted"); // clear any stale stuck-mute flag from older builds
    this.loaded = true;
  }

  // re-assert the master mute on the (global) sound manager for the current scene
  applyMute(scene: Phaser.Scene): void {
    this.load();
    scene.sound.mute = this.muted;
  }

  // Stop+destroy EVERY music-keyed sound in the (global) SoundManager — not just the one we
  // tracked. Bulletproof against orphan tracks created by any path (double create, scene reuse,
  // HMR). After this, zero music sounds exist.
  stopAllMusic(scene: Phaser.Scene): void {
    for (const s of (scene.sound as unknown as { sounds: Phaser.Sound.BaseSound[] }).sounds.slice()) {
      if (isMusicKey(s.key)) { s.stop(); s.destroy(); }
    }
    this.music = undefined;
  }

  // Start (or keep) a looping track. If the requested track is ALREADY the only music playing,
  // just sync its volume; otherwise nuke ALL music and start exactly one. Two tracks can never
  // overlap, and switching scenes always replaces cleanly.
  playMusic(scene: Phaser.Scene, key: string): void {
    this.load();
    const musics = (scene.sound as unknown as { sounds: Phaser.Sound.BaseSound[] }).sounds.filter((s: Phaser.Sound.BaseSound) => isMusicKey(s.key));
    if (musics.length === 1 && musics[0].key === key) {
      (musics[0] as Phaser.Sound.WebAudioSound).setVolume(this.musicVol);
      this.music = musics[0]; scene.sound.mute = this.muted;
      return;
    }
    this.stopAllMusic(scene); // remove any/all existing music (orphans included)
    if (!scene.cache.audio.exists(key)) return;
    this.music = scene.sound.add(key, { loop: true, volume: this.musicVol });
    this.music.play();
    scene.sound.mute = this.muted;
  }

  stopMusic(scene?: Phaser.Scene): void {
    if (scene) { this.stopAllMusic(scene); return; }
    this.music?.stop();
    this.music?.destroy();
    this.music = undefined;
  }

  // base = per-event mix (0..1); final = sfxVol * base. Master mute silences via the SoundManager.
  sfx(scene: Phaser.Scene, key: string, base = 1): void {
    this.load();
    if (scene.cache.audio.exists(key)) scene.sound.play(key, { volume: this.sfxVol * base });
  }

  setMusicVol(v: number): void {
    this.musicVol = Phaser.Math.Clamp(v, 0, 1);
    localStorage.setItem(LS.music, String(this.musicVol));
    const cur = this.music as Phaser.Sound.WebAudioSound | undefined;
    cur?.setVolume(this.musicVol);
  }

  setSfxVol(v: number): void {
    this.sfxVol = Phaser.Math.Clamp(v, 0, 1);
    localStorage.setItem(LS.sfx, String(this.sfxVol));
  }

  // master mute (all channels) — SESSION-ONLY (not persisted), so a reload always restores sound
  toggleMute(scene: Phaser.Scene): boolean {
    this.muted = !this.muted;
    scene.sound.mute = this.muted;
    return this.muted;
  }
}

export const audio = new AudioManager();
