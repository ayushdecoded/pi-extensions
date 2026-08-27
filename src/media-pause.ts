import { execFile } from "node:child_process";

/**
 * Pauses MPRIS media players while voice input is recording, mirroring the
 * behavior of Omarchy's native dictation (Voxtype `pause_media`): pause
 * anything that speaks MPRIS the moment recording starts, resume on release.
 *
 * Talks MPRIS over the session bus via `busctl` (part of systemd, so present
 * on every modern Linux desktop — no extra packages). Each player is handled
 * independently, so one stuck player can't block the rest; every failure
 * degrades to a no-op so media handling can never break recording.
 */
export interface MediaPause {
  /** Snapshot currently-playing MPRIS players, pause them, and return their names. */
  pause(): Promise<string[]>;
  /** Resume the given players (previously paused by pause()). No-op when empty. */
  resume(players: string[]): Promise<void>;
}

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const PLAYER_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

/** Default MediaPause backed by busctl on the session bus. */
export function mprisMediaPause(timeoutMs = 2000): MediaPause {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        "busctl",
        ["--user", "--no-pager", `--timeout=${Math.ceil(timeoutMs / 1000)}`, ...args],
        { encoding: "utf8", timeout: timeoutMs },
        // A failing call (missing bus, player vanished mid-query) just yields
        // empty output; callers treat that as "nothing to do".
        (_error, stdout) => resolve(stdout),
      );
    });

  return {
    async pause(): Promise<string[]> {
      const listing = await run(["list", "--no-legend"]);
      const players = listing
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter((name) => name.startsWith(MPRIS_PREFIX));
      // Check statuses in parallel; keep only players actually playing.
      const playing = (await Promise.all(
        players.map(async (name) => {
          const status = await run(["get-property", name, PLAYER_PATH, PLAYER_IFACE, "PlaybackStatus"]);
          // busctl prints string properties as `s "Playing"`.
          return status.includes("Playing") ? name : null;
        }),
      )).filter((name): name is string => name !== null);
      await Promise.all(playing.map((name) => run(["call", name, PLAYER_PATH, PLAYER_IFACE, "Pause"])));
      return playing;
    },
    async resume(players: string[]): Promise<void> {
      await Promise.all(players.map((name) => run(["call", name, PLAYER_PATH, PLAYER_IFACE, "Play"])));
    },
  };
}
