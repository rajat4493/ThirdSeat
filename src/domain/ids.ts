import { randomUUID } from 'node:crypto';

let counter = 0;
const deterministic = process.env.THIRDSEAT_DETERMINISTIC_IDS === '1';

export function newId(prefix: string): string {
  if (deterministic) return `${prefix}_${++counter}`;
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function resetIds(): void {
  counter = 0;
}
