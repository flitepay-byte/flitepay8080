/**
 * Shared plumbing for the end-to-end audit.
 *
 * Everything here runs against its own database — never the developer's. The
 * audit creates and destroys hundreds of records and deliberately drives the
 * system into broken states, which is not something to do to data anyone is
 * working with.
 */
import mongoose from 'mongoose';

export const AUDIT_DB = 'otdms_audit';

export function auditMongoUri(): string {
  const raw = process.env['MONGO_URI'] ?? 'mongodb://127.0.0.1:27017/otdms';
  const match = raw.match(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/([^/?]*)(.*)$/);
  if (!match) throw new Error(`Cannot derive an audit database from MONGO_URI: ${raw}`);
  const [, prefix, , suffix] = match;
  return `${prefix}/${AUDIT_DB}${suffix}`;
}

/** Refuses to run anywhere but the audit database. */
export function assertAuditDatabase(): void {
  const name = mongoose.connection.name;
  if (name !== AUDIT_DB) {
    throw new Error(`Refusing to run: connected to "${name}", expected "${AUDIT_DB}"`);
  }
}

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface Finding {
  severity: Severity;
  area: string;
  title: string;
  reproduction: string;
  expected: string;
  actual: string;
  impact: string;
  evidence?: string;
  roles: string[];
}

export interface Scenario {
  area: string;
  name: string;
  passed: boolean;
  detail?: string;
}

const findings: Finding[] = [];
const scenarios: Scenario[] = [];

export function record(area: string, name: string, passed: boolean, detail?: string): boolean {
  scenarios.push({ area, name, passed, ...(detail ? { detail } : {}) });
  const mark = passed ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${detail && !passed ? ` — ${detail}` : ''}`);
  return passed;
}

export function report(finding: Finding): void {
  findings.push(finding);
  console.log(`  >> ${finding.severity} ${finding.area}: ${finding.title}`);
}

export function results(): { findings: Finding[]; scenarios: Scenario[] } {
  return { findings, scenarios };
}

export function summarise(): void {
  const passed = scenarios.filter((s) => s.passed).length;
  console.log(`\n---- ${passed}/${scenarios.length} scenarios passed, ${findings.length} findings ----`);
}

/** Deterministic pseudo-random, so a failing run can be replayed exactly. */
export class Rng {
  private seed: number;

  constructor(seed = 20260904) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return this.seed / 2147483648;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
