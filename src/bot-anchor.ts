/**
 * Bot anchor implementation — lihat src/instrumentation.ts untuk konteks lengkap.
 * Modul ini di-import dinamis (nodejs runtime only) agar tidak memengaruhi build edge.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import net from "node:net";

const SERVICE_DIR = "/home/z/my-project/mini-services/trend-scraper-python";
const LOG_PATH = "/home/z/my-project/.zscripts/mini-service-trend-scraper-python.log";
/** venv Python berisi `requests` — dipastikan di depan PATH (env boot tidak selalu memuatnya). */
const VENV_BIN = "/home/z/.venv/bin";

/** True bila ada service bot hidup di :4020 (TCP connect cepat). */
function botAlive(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 4020 });
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

let spawning = false;

async function ensureChain() {
  if (spawning) return;
  try {
    if (await botAlive()) return; // bot hidup — supervisor pasti ada (atau akan mengadopsi)
  } catch {
    /* lanjut spawn */
  }
  spawning = true;
  try {
    const out = openSync(LOG_PATH, "a");
    console.log("[bot-anchor] bot mati — menumbuhkan supervisor dari next-server …");
    const child = spawn("bun", ["supervisor.ts"], {
      cwd: SERVICE_DIR,
      env: { ...process.env, PATH: `${VENV_BIN}:${process.env.PATH ?? ""}` },
      // CATATAN: node:child_process memakai opsi `stdio` (bukan stdout/stderr gaya Bun).
      stdio: ["ignore", out, out],
    });
    child.unref(); // next-server tidak menunggu — child berdiri sendiri
    child.once("error", (e) => console.error("[bot-anchor] spawn gagal:", e));
  } catch (e) {
    console.error("[bot-anchor] ensureChain error:", e);
  } finally {
    // Jeda agar supervisor sempat bind / agar probe berikutnya tidak spawn bertubi-tubi
    setTimeout(() => (spawning = false), 30_000).unref?.();
  }
}

export function startBotAnchor() {
  console.log("[bot-anchor] aktif — next-server menjaga rantai supervisor→bot (cek 60 dtk)");
  void ensureChain();
  const timer = setInterval(() => void ensureChain(), 60_000);
  // unref: timer tidak menahan proses Next.js tetap hidup
  (timer as unknown as { unref?: () => void }).unref?.();
}
