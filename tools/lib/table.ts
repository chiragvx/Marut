/**
 * tools/lib/table.ts — implements FormatPerformanceTable (contracts/verify.ts).
 * Pure text formatting, no I/O. See docs/spec/12-verification.md section 2.
 */
import type { FormatPerformanceTable, PerformanceCheckResult } from '../../src/contracts/verify';

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

const COLS: ReadonlyArray<{ header: string; width: number }> = [
  { header: 'Category', width: 22 },
  { header: 'Condition', width: 34 },
  { header: 'Target', width: 14 },
  { header: 'Measured', width: 14 },
  { header: 'Tolerance', width: 11 },
  { header: 'Result', width: 6 },
];

function row(cells: readonly string[]): string {
  return cells.map((c, i) => pad(c, (COLS[i] as { header: string; width: number }).width)).join(' | ');
}

export const formatPerformanceTable: FormatPerformanceTable = (
  results: readonly PerformanceCheckResult[]
): string => {
  const lines: string[] = [];
  lines.push(row(COLS.map((c) => c.header)));
  lines.push(COLS.map((c) => '-'.repeat(c.width)).join('-+-'));
  for (const r of results) {
    const t = r.target;
    lines.push(
      row([
        `${t.id} (${t.kind})`,
        t.configNote,
        `${fmtNum(t.targetValue)} ${t.unit}`,
        `${fmtNum(r.measured)} ${t.unit}`,
        `+-${(t.toleranceRel * 100).toFixed(0)}%`,
        r.passed ? 'PASS' : 'FAIL',
      ])
    );
  }
  const passCount = results.filter((r) => r.passed).length;
  lines.push('');
  lines.push(`${passCount}/${results.length} targets passed.`);
  return lines.join('\n');
};
