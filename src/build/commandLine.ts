/**
 * Splits a terminal command into a program and arguments without a shell. Quotes group words;
 * shell features (pipes, redirection, chaining, substitution, variables) are refused with a
 * plain explanation rather than passed to a shell.
 */
export class CommandLineError extends Error {}

const OPERATORS: [RegExp, string][] = [
  [/^\|/, 'Pipes (|) are not supported. Run one command at a time.'],
  [/^&/, 'Chaining or background jobs (&, &&) are not supported. Run one command at a time.'],
  [/^;/, 'Chaining commands with ; is not supported. Run one command at a time.'],
  [/^[<>]/, 'Redirection (< and >) is not supported. Commands write their output here.'],
  [/^`/, 'Command substitution is not supported.'],
  [/^\$[({]/, 'Shell substitution ($(…) and ${…}) is not supported.'],
  [/^\$[A-Za-z_]/, 'Shell variables are not expanded here. Put settings in the project’s .env file.'],
];

export function parseCommandLine(input: string): { program: string; args: string[] } {
  const text = input.trim();
  if (!text) throw new CommandLineError('Type a command, for example npm test.');
  if (/[\r\n]/.test(text)) throw new CommandLineError('Run one command at a time.');
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new CommandLineError('A quote is not closed.');
      current += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let chunk = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && (text[j + 1] === '"' || text[j + 1] === '\\')) {
          chunk += text[j + 1];
          j += 2;
        } else if (text[j] === '$' || text[j] === '`') {
          throw new CommandLineError('Shell substitution and variables are not supported here.');
        } else {
          chunk += text[j];
          j += 1;
        }
      }
      if (j >= text.length) throw new CommandLineError('A quote is not closed.');
      current += chunk;
      inWord = true;
      i = j + 1;
      continue;
    }
    const rest = text.slice(i);
    for (const [re, message] of OPERATORS) if (re.test(rest)) throw new CommandLineError(message);
    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      i += 2;
      inWord = true;
      continue;
    }
    current += ch;
    inWord = true;
    i += 1;
  }
  if (inWord) words.push(current);
  const [program, ...args] = words;
  if (!program) throw new CommandLineError('Type a command, for example npm test.');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) throw new CommandLineError('Setting variables before a command is not supported. Put settings in the project’s .env file.');
  if (/[\\/]/.test(program) && !/^\.{0,2}\//.test(program) && !/^[A-Za-z]:/.test(program)) throw new CommandLineError('Use a program name such as npm or node.');
  if (program === 'sudo' || program === 'su') throw new CommandLineError('Commands run with your normal permissions; administrator commands are not supported here.');
  return { program, args };
}
