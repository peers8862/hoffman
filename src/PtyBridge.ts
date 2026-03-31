import { EventEmitter } from "events";
import * as nodePath from "path";

export class PtyBridge extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private process: any | null = null;

  constructor(
    private pluginDir: string,
    private shell: string,
    private cwd: string,
    private cols: number,
    private rows: number,
    private env: Record<string, string>
  ) {
    super();
  }

  /** PID of the running shell process, or null if not started / already exited. */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  start() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pty = require(nodePath.join(this.pluginDir, "node_modules_bundled", "node-pty"));

      this.process = pty.spawn(this.shell, [], {
        name: "xterm-256color",
        cols: Math.max(this.cols, 2),
        rows: Math.max(this.rows, 2),
        cwd: this.cwd,
        env: { ...process.env, ...this.env } as Record<string, string>,
      });

      this.process.onData((data: string) => this.emit("data", data));
      this.process.onExit(({ exitCode }: { exitCode: number }) =>
        this.emit("exit", exitCode)
      );
    } catch (err) {
      this.emit("error", err);
    }
  }

  /**
   * Kill the current process, update the working directory, and spawn a new one.
   * Used to wake a hibernated tab in its last-known cwd.
   */
  restart(cwd: string) {
    this.kill();
    this.cwd = cwd;
    this.start();
  }

  write(data: string) {
    this.process?.write(data);
  }

  resize(cols: number, rows: number) {
    if (this.process && cols > 1 && rows > 1) {
      try {
        this.process.resize(cols, rows);
      } catch {
        // ignore resize errors (process may be exiting)
      }
    }
  }

  kill() {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // ignore
      }
      this.process = null;
    }
  }
}
