import { execFile } from "node:child_process";

/**
 * Pauses MPRIS media players while voice input is recording, mirroring the
 * behavior of Omarchy's native dictation (Voxtype `pause_media`): pause
 * anything that speaks MPRIS the moment recording starts, resume on release.
 *
 * Backed by the `playerctl` CLI. Every failure degrades to a no-op so media
 * handling can never break recording or transcription.
 */
export interface MediaPause {
  /** Snapshot currently-playing MPRIS players, pause them, and return their names. */
  pause(): Promise<string[]>;
  /** Resume the given players (previously paused by pause()). No-op when empty. */
  resume(players: string[]): Promise<void>;
}

/** Default MediaPause backed by the playerctl CLI (installed on Omarchy). */
export function playerctlMediaPause(timeoutMs = 2000): MediaPause {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile("playerctl", args, { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
        resolve(error ? "" : stdout);
      });
    });

  return {
    async pause(): Promise<string[]> {
      const status = await run(["--all-players", "--no-messages", "--format", "{{playerName}}\t{{status}}", "status"]);
      const playing = status
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length === 2 && parts[1] === "Playing")
        .map((parts) => parts[0]);
      if (playing.length > 0) await run(["--all-players", "--no-messages", "pause"]);
      return playing;
    },
    async resume(players: string[]): Promise<void> {
      if (players.length === 0) return;
      await run([`--player=${players.join(",")}`, "--no-messages", "play"]);
    },
  };
}
