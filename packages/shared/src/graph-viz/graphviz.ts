import { spawnSync } from 'node:child_process';
import { writeBytesAtomicDurable } from '../atomic-write.js';

// Largest rendered image read back from Graphviz before it is written.
const MAX_RENDER_BYTES = 256 * 1024 * 1024;

/** Check if Graphviz `dot` binary is available. */
export function isDotAvailable(): boolean {
  const result = spawnSync('dot', ['-V'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0;
}

// Graphviz renders to stdout; the image is then staged beside `outPath` and
// renamed into place, so a link at `outPath` is replaced rather than written
// through, and a failed render leaves `outPath` as it was. Like a failed
// render, a failed image write is reported as a warning.
function renderTo(layoutEngine: string, format: 'png' | 'svg', dotBuffer: Buffer, outPath: string): void {
  const result = spawnSync(layoutEngine, [`-T${format}`], {
    input: dotBuffer,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_RENDER_BYTES,
  });
  if (result.status !== 0 || result.error) {
    console.warn(`[graph-viz] dot ${format.toUpperCase()} failed:`, result.error?.message ?? result.stderr?.toString());
    return;
  }
  try {
    writeBytesAtomicDurable(outPath, result.stdout);
  } catch (err) {
    console.warn(`[graph-viz] writing ${format.toUpperCase()} failed:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Write DOT source to file and optionally invoke Graphviz to render PNG/SVG.
 * If `dot` is not installed, writes .dot file and logs a warning (never throws).
 */
export function runDot(
  dotSource: string,
  opts: {
    outDot?: string;
    outPng?: string;
    outSvg?: string;
    layoutEngine?: string;
  }
): void {
  const { outDot, outPng, outSvg, layoutEngine = 'dot' } = opts;

  if (outDot) {
    writeBytesAtomicDurable(outDot, dotSource);
  }

  if (!outPng && !outSvg) return;

  if (!isDotAvailable()) {
    console.warn('[graph-viz] Graphviz `dot` not found. Skipping PNG/SVG generation.');
    return;
  }

  const dotBuffer = Buffer.from(dotSource, 'utf8');
  if (outPng) renderTo(layoutEngine, 'png', dotBuffer, outPng);
  if (outSvg) renderTo(layoutEngine, 'svg', dotBuffer, outSvg);
}
