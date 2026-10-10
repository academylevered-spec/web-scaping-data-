/**
 * Supervisor — menjaga proses Python scraper tetap hidup 24/7.
 * Restart otomatis dengan backoff bila proses keluar (crash/OOM).
 *
 * SINGLE-INSTANCE GUARD: bila supervisor lain sudah hidup (pidfile valid),
 * proses ini langsung keluar — mencegah bot ganda saat boot script
 * ter-eksekusi dua kali (pernah menyebabkan crash-loop spawn port 4020).
 *
 * KEEP-ALIVE v8 (Task KEEP-ALIVE):
 *  - PREFLIGHT ensure_env.py : .env hilang (mis. sandbox reset) → dipulihkan
 *    otomatis dari git history SEBELUM spawn — tidak ada lagi crash-loop
 *    "kredensial kosong" selamanya (insiden nyata 2026-10-10).
 *  - down.json : bila bot mati cepat berulang, tulis {down, reason, ...}
 *    → realtime service membacanya → UI menampilkan ALASAN NYATA
 *    (bukan "coba lagi 1-2 menit" yang menyesatkan).
 *  - down.json dihapus otomatis saat bot pulih (alive >90 dtk / terdeteksi hidup).
 */
import { unlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import net from "node:net";

const LOCK_FILE = `${import.meta.dir}/.supervisor.lock`;
const DOWN_FILE = `${import.meta.dir}/down.json`;

function pidAlive(pid: number): boolean {
  try {
    // /proc/<pid> ada => proses hidup (Linux)
    return existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
        // Verifikasi PID itu benar supervisor dari folder ini (bukan PID daur ulang)
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
          if (cmdline.includes("supervisor.ts")) {
            console.log(
              `[supervisor] instance lain sudah hidup (pid=${pid}) — keluar tanpa menjalankan bot kedua.`
            );
            return false;
          }
        } catch {
          /* /proc ada tapi cmdline tak terbaca → anggap hidup (aman) */
          console.log(`[supervisor] pidfile aktif (pid=${pid}, tak terverifikasi) — keluar.`);
          return false;
        }
      }
      // PID mati / daur ulang → ambil alih lock
      console.log(`[supervisor] pidfile basi (pid=${raw}) — ambil alih lock.`);
      unlinkSync(LOCK_FILE);
    }
  } catch {
    /* pidfile rusak → hapus dan lanjut */
    try {
      unlinkSync(LOCK_FILE);
    } catch {}
  }
  writeFileSync(LOCK_FILE, String(process.pid), "utf8");
  return true;
}

function releaseLock() {
  try {
    const raw = readFileSync(LOCK_FILE, "utf8").trim();
    if (raw === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch {}
}

// ── KEEP-ALIVE v8: down.json lifecycle ─────────────────────────────────
let restarts = 0;

function writeDown(reason: string, exitCode: number | null) {
  try {
    writeFileSync(
      DOWN_FILE,
      JSON.stringify(
        {
          down: true,
          reason: String(reason).slice(0, 300),
          lastExitCode: exitCode,
          restarts,
          sinceMs: Date.now(),
        },
        null,
        2
      )
    );
  } catch {}
}

function clearDown() {
  try {
    if (existsSync(DOWN_FILE)) unlinkSync(DOWN_FILE);
  } catch {}
}

/**
 * PREFLIGHT KREDENSIAL (KEEP-ALIVE L1) — jalankan ensure_env.py.
 * Return {ok, reason}: bila gagal, reason = pesan FATAL-nya (tanpa nilai rahasia)
 * untuk down.json.
 */
async function ensureEnv(): Promise<{ ok: boolean; reason: string }> {
  try {
    const proc = Bun.spawn(["python3", "-u", "ensure_env.py"], {
      cwd: import.meta.dir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, rej) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          rej(new Error("timeout"));
        }, 60_000)
      ),
    ]);
    const out = await new Response(proc.stdout as unknown as ReadableStream).text();
    for (const line of out.split("\n")) if (line.trim()) console.log(`[ensure_env] ${line.trim()}`);
    if (code === 0) return { ok: true, reason: "" };
    const fatal = out.split("\n").find((l) => l.includes("FATAL")) ?? `ensure_env exit code=${code}`;
    return { ok: false, reason: fatal.replace("[ensure_env] ", "").trim() };
  } catch (e) {
    return { ok: false, reason: `ensure_env gagal dijalankan: ${String(e).slice(0, 160)}` };
  }
}

/**
 * DIAGNOSIS cepat pasca bot mati cepat (uptime <60 dtk): tanya config.validate()
 * — pesan validasi TIDAK memuat nilai rahasia, aman dipamerkan ke UI.
 */
async function diagnoseConfig(): Promise<string> {
  try {
    const proc = Bun.spawn(["python3", "-c", "import config; print('|'.join(config.validate()))"], {
      cwd: import.meta.dir,
      env: process.env,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, rej) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          rej(new Error("timeout"));
        }, 20_000)
      ),
    ]);
    if (code !== 0) return "";
    const out = (await new Response(proc.stdout as unknown as ReadableStream).text()).trim();
    return out.replace(/\|/g, " — ");
  } catch {
    return "";
  }
}

let delayMs = 2000;
let lastStart = Date.now();

const REQUIREMENTS = `${import.meta.dir}/requirements.txt`;

/**
 * v5.1 PREFLIGHT DEPENDENSI — akar masalah crash-loop pasca deploy.
 *
 * Latar: boot pipeline men-start mini services SEBELUM venv Python siap.
 * Supervisor spawn bot → `ModuleNotFoundError: No module named 'requests'`
 * → mati instan → retry 30s → crash-loop ±16 menit tiap deploy/reboot.
 * Selama window itu, POST /api/sync dari web → 502 → toast error di user.
 *
 * Fix: sebelum spawn, verifikasi `import requests` benar-benar bisa; bila
 * gagal, install requirements.txt DULU (dgn batas waktu 5 menit). Spawn bot
 * HANYA saat dependensi siap — tidak ada lagi spawn-mati-spawn-mati.
 */
async function depsReady(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["python3", "-c", "import requests"], {
      cwd: import.meta.dir,
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, rej) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          rej(new Error("timeout"));
        }, 20_000)
      ),
    ]);
    return code === 0;
  } catch {
    return false;
  }
}

async function installDeps(): Promise<boolean> {
  console.log(
    "[supervisor] preflight: dependensi Python belum siap — `pip install -r requirements.txt` …"
  );
  try {
    const proc = Bun.spawn(
      ["python3", "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", REQUIREMENTS],
      {
        cwd: import.meta.dir,
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      }
    );
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, rej) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          rej(new Error("pip timeout 300s"));
        }, 300_000)
      ),
    ]);
    if (code === 0) {
      console.log("[supervisor] preflight: pip install sukses.");
      return true;
    }
    console.log(`[supervisor] preflight: pip keluar code=${code} — dicoba lagi nanti.`);
  } catch (e) {
    console.log(`[supervisor] preflight: pip gagal: ${e}`);
  }
  return false;
}

/** Bila true, ada bot hidup di port 4020 — supervisor pasif (monitor), jangan spawn kedua.
 *  FIX KEEP-ALIVE: Bun.connect({hostname,port}) TANPA opsi `socket` selalu melempar
 *  TypeError (ERR_INVALID_ARG_TYPE) di Bun 1.3.14 → probe lama SELALU false →
 *  supervisor tak pernah bisa mengadopsi bot hidup (spawn-ganda EADDRINUSE tiap siklus).
 *  Dipakai node:net (pola terbukti dari bot-anchor.ts). */
const BOT_PORT = 4020;

function botAlive(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: BOT_PORT });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function run() {
  // start bersih: down.json dari sesi supervisor sebelumnya tidak relevan lagi
  clearDown();
  for (;;) {
    // ADOPTION: bila bot sudah hidup (mis. spawn oleh supervisor lama yang mati),
    // jangan spawn kedua — cukup pantau. Bila bot mati, supervisor ambil alih.
    if (await botAlive()) {
      clearDown(); // bot hidup = pulih — pastikan penanda down terhapus
      console.log(`[supervisor] bot terdeteksi hidup di :${BOT_PORT} — mode pasif (cek 30s).`);
      await Bun.sleep(30_000);
      continue;
    }

    // v5.1: pastikan dependensi siap SEBELUM spawn — bila belum, install dulu.
    // Loop tetap hidup & menunggu 30s (bukan spawn bot yang langsung mati).
    if (!(await depsReady())) {
      if (!(await installDeps()) || !(await depsReady())) {
        console.log(
          "[supervisor] dependensi belum siap — tunggu 30s (tanpa spawn bot, tanpa crash-loop)."
        );
        await Bun.sleep(30_000);
        continue;
      }
    }

    // KEEP-ALIVE L1: pulihkan .env bila hilang (sandbox reset). Bila gagal
    // permanen (kredensial tidak ada di mana pun), tulis down.json + tunggu
    // 60s — user diberi alasan NYATA via UI, bukan pesan generik.
    const env = await ensureEnv();
    if (!env.ok) {
      writeDown(env.reason, null);
      console.log("[supervisor] kredensial belum siap — tunggu 60s (lihat down.json untuk alasan).");
      await Bun.sleep(60_000);
      continue;
    }

    lastStart = Date.now();
    restarts += 1;
    console.log(`[supervisor] preflight OK — menjalankan python3 -u main.py ...`);
    const proc = Bun.spawn(["python3", "-u", "main.py"], {
      cwd: import.meta.dir,
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });

    let clearedWhileRunning = false;
    const exitWatcher = setInterval(() => {
      const uptime = Date.now() - lastStart;
      if (uptime > 5 * 60_000) {
        delayMs = 2000; // proses stabil ≥5 menit → reset backoff
      }
      if (uptime > 90_000 && !clearedWhileRunning) {
        clearedWhileRunning = true;
        clearDown(); // bot bertahan >90 dtk = benar-benar pulih
      }
    }, 60_000);

    const code = await proc.exited;
    clearInterval(exitWatcher);
    const uptimeMs = Date.now() - lastStart;
    console.log(`[supervisor] python keluar (code=${code}, uptime=${Math.round(uptimeMs / 1000)}s) — restart dalam ${delayMs / 1000}s`);

    // KEEP-ALIVE L2: bot mati cepat → tulis alasan nyata untuk UI.
    if (uptimeMs < 60_000) {
      const reason = (await diagnoseConfig()) || `bot keluar code=${code} setelah ${Math.round(uptimeMs / 1000)}s`;
      writeDown(reason, code);
      console.log(`[supervisor] down.json ditulis: ${reason.slice(0, 160)}`);
    }

    await Bun.sleep(delayMs);
    delayMs = Math.min(30_000, delayMs * 2);
  }
}

process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});

if (!acquireLock()) {
  process.exit(0);
}
console.log(`[supervisor] lock didapat (pid=${process.pid}) — memulai bot.`);
run();
