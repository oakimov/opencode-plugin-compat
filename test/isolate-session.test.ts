import { describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Linux owns the pid namespace; macOS must settle every process group in
// the session. The child acknowledges its new group before the leader exits.
describe.skipIf(process.platform !== "darwin")("isolation session ownership", () => {
  for (const mode of ["success", "failure", "cancel", "inspection-retry"] as const) {
    it(`settles a same-session child in another process group on ${mode}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isolate-session-"))
      const childFile = path.join(dir, "child.pid")
      const ready = path.join(dir, "ready")
      const bin = path.join(dir, "bin")
      const inspectionFailed = path.join(dir, "inspection-failed")
      fs.mkdirSync(bin)
      if (mode === "inspection-retry") {
        fs.writeFileSync(path.join(bin, "ps"), [
          "#!/bin/sh",
          'if [ ! -e "$PROBE_INSPECTION_FAILED" ]; then : > "$PROBE_INSPECTION_FAILED"; exit 1; fi',
          'exec /bin/ps "$@"',
          "",
        ].join("\n"), { mode: 0o755 })
      }
      fs.writeFileSync(path.join(dir, "child.py"), [
        "import os, pathlib, signal, sys, time",
        "root = pathlib.Path(sys.argv[1])",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "(root / 'child.pid').write_text(str(os.getpid()))",
        "(root / 'ready').write_text('1')",
        "while True: time.sleep(0.1)",
        "",
      ].join("\n"))
      fs.writeFileSync(path.join(dir, "leader.py"), [
        "import os, pathlib, subprocess, sys, time",
        "root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]",
        "subprocess.Popen([sys.executable, str(root / 'child.py'), str(root)], preexec_fn=os.setpgrp, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        "while not (root / 'ready').exists(): time.sleep(0.01)",
        "if mode == 'cancel': time.sleep(20)",
        "raise SystemExit(7 if mode == 'failure' else 0)",
        "",
      ].join("\n"))
      const owner = spawn("bash", ["-c", `
        source scripts/isolate-run.sh
        set +e
        isolate_supervise "$1" python3 "$1/leader.py" "$1" "$2"
      `, "probe", dir, mode], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROBE_INSPECTION_FAILED: inspectionFailed, ISOLATE_TERM_GRACE: "0", PYTHONDONTWRITEBYTECODE: "1" },
      })
      owner.stdout.resume()
      let stderr = ""
      owner.stderr.on("data", chunk => { stderr += chunk })
      const exited = new Promise<number | null>(resolve => owner.on("exit", resolve))
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const deadline = Date.now() + 5000
        while (!fs.existsSync(ready)) {
          if (owner.exitCode !== null || owner.signalCode !== null || Date.now() > deadline) throw new Error(`child did not start: ${stderr}`)
          await Bun.sleep(10)
        }
        if (mode === "cancel") owner.kill("SIGTERM")
        const status = await Promise.race([
          exited,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`owner did not settle: ${stderr}`)), 5000) }),
        ])
        expect(status, stderr).toBe(mode === "cancel" ? 143 : mode === "failure" ? 7 : 0)
        const pid = Number(fs.readFileSync(childFile, "utf8"))
        let alive = true
        try { process.kill(pid, 0) } catch { alive = false }
        expect(alive, stderr).toBe(false)
        if (mode === "inspection-retry") expect(fs.existsSync(inspectionFailed)).toBe(true)
      } finally {
        clearTimeout(timer)
        if (fs.existsSync(childFile)) {
          try { process.kill(Number(fs.readFileSync(childFile, "utf8")), "SIGKILL") } catch { /* already gone */ }
        }
        if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL")
        await exited
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
