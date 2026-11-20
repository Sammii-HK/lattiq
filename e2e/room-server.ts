import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ROOM_SECRET, WS_PORT } from "./env";

/**
 * Runs server/index.ts as a child process so tests can take it down and
 * bring it back, with persistence in a throwaway directory.
 */
export class RoomServer {
  readonly dataDir: string;
  private proc: ChildProcess | null = null;

  constructor() {
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattiq-rooms-"));
  }

  async start(): Promise<number> {
    if (this.proc) return 0;
    const t0 = Date.now();
    const proc = spawn(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["server/index.ts"],
      {
        env: {
          ...process.env,
          PORT: String(WS_PORT),
          LATTIQ_ROOM_SECRET: ROOM_SECRET,
          LATTIQ_DATA_DIR: this.dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    this.proc = proc;
    proc.stderr?.on("data", (d) => {
      const line = String(d);
      if (!line.includes("LATTIQ_ROOM_SECRET")) process.stderr.write(`[room-server] ${line}`);
    });
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://localhost:${WS_PORT}/healthz`);
        if (res.ok) return Date.now() - t0;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("room server did not start");
  }

  /** SIGTERM: the server saves dirty rooms and closes sockets. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGTERM");
    });
  }

  async dispose() {
    await this.stop();
    fs.rmSync(this.dataDir, { recursive: true, force: true });
  }
}
