/**
 * Bot anchor v5.1 — menumbuhkan rantai supervisor→bot dari proses Next.js.
 *
 * Latar masalah: sandbox mereap SELURUH subtree proses yang lahir dari tool-call
 * (eksperimen: nohup/setsid/disown/orphan semuanya mati dalam hitungan menit).
 * Hanya keturunan proses boot-anchored yang selamat — bukti: postcss.js, anak
 * next-server, hidup lintas masa hidup tool-call.
 *
 * Karena dev.sh men-start Next.js SEBELUM mini-services, dan boot pipeline
 * bisa men-start bot sebelum venv siap (crash-loop 16 menit setelah deploy),
 * anchor ini membuat next-server (proses paling reliabel milik user) menjadi
 * akar rantai bot:
 *
 *   next-server (boot-anchored) → bun supervisor.ts (preflight deps) → python bot
 *
 * Keamanan berlapis:
 *   - global flag      : register() tak dieksekusi ganda dalam satu proses
 *   - TCP probe :4020  : bot hidup → tidak spawn apa pun
 *   - pidfile lock     : supervisor kedua keluar sendiri (single-instance)
 *   - adoption         : supervisor mengadopsi bot yang sudah hidup (mode pasif)
 *   - bot watchdog     : bot menjaga supervisor tetap hidup (ensure_supervisor)
 *   - interval 60 dtk  : bila bot+supervisor mati, next-server membangun ulang
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as { __trendBotAnchorStarted?: boolean };
  if (g.__trendBotAnchorStarted) return;
  g.__trendBotAnchorStarted = true;

  try {
    const { startBotAnchor } = await import("./bot-anchor");
    startBotAnchor();
  } catch (e) {
    console.error("[bot-anchor] gagal dimulai:", e);
  }
}
