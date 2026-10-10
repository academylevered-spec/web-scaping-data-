/**
 * Gradient cover deterministik (client-safe, tanpa dependency DB).
 * Dipakai sebagai latar fallback bila thumbnail/produk asli gagal dimuat.
 */

const GRADIENTS: Array<[string, string]> = [
  ["#0f172a", "#334155"],
  ["#1c1917", "#57534e"],
  ["#052e2b", "#0f766e"],
  ["#2d1b0e", "#b45309"],
  ["#1a2e05", "#4d7c0f"],
  ["#2e1065", "#7c3aed"],
  ["#500724", "#be185d"],
  ["#0c2d48", "#0369a1"],
  ["#3b0764", "#a21caf"],
  ["#431407", "#ea580c"],
  ["#022c22", "#059669"],
  ["#450a0a", "#dc2626"],
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function gradientStyle(seed: string): React.CSSProperties {
  const h = hashStr(seed);
  const [c1, c2] = GRADIENTS[h % GRADIENTS.length];
  const angle = 100 + (h % 80);
  return { background: `linear-gradient(${angle}deg, ${c1}, ${c2})` };
}
