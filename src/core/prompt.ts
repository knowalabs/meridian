import readline from 'node:readline';
import pc from 'picocolors';

/** Ask a plain question and return the trimmed answer. */
export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt on the TTY without echoing the secret. */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(question);
    // Suppress readline's echo so the key is never printed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

export interface Choice {
  value: string;
  label: string;
  /** Extra note rendered dimmed after the label, e.g. "installed". */
  note?: string;
}

/**
 * Show a numbered list and let the user pick by number or value.
 * Returns null when the answer matches nothing (or input is not a TTY).
 */
export async function promptChoice(question: string, choices: Choice[]): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  for (const [i, choice] of choices.entries()) {
    const note = choice.note ? ` ${pc.dim(`(${choice.note})`)}` : '';
    console.log(`  ${pc.cyan(String(i + 1).padStart(2))}. ${choice.label}${note}`);
  }
  const answer = await promptLine(`${question} `);
  if (!answer) return null;
  const byIndex = choices[Number(answer) - 1];
  if (byIndex) return byIndex.value;
  const byValue = choices.find((c) => c.value === answer.toLowerCase());
  return byValue ? byValue.value : null;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((current[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = current;
  }
  return prev[b.length] ?? 0;
}

/** Closest candidate to `input`, or null when nothing is reasonably close. */
export function didYouMean(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}
