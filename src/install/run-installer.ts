import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** True when a Windows executable is a console program (as opposed to one with its own window). */
export function isConsoleProgram(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (n < 0x40 || buf.toString('ascii', 0, 2) !== 'MZ') return false;
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 96 > n || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return false;
    return buf.readUInt16LE(pe + 24 + 68) === 3; // IMAGE_SUBSYSTEM_WINDOWS_CUI
  } catch {
    return false;
  }
}

// Inside a batch file, % starts a variable. Everything else we use is safe inside double quotes.
const batchQuote = (s: string): string => `"${s.replace(/%/g, '%%')}"`;

/** Plain arguments such as /c or -e stay unquoted: some programs (cmd.exe among them) do not
 *  treat a quoted "/c" as a switch. Anything else is quoted. */
function batchArg(s: string): string {
  if (/["\r\n\0]/.test(s)) throw new Error('An installer argument contains a character that cannot be passed safely.');
  return /^[A-Za-z0-9_.\-/\\:=+,@]+$/.test(s) ? s : batchQuote(s);
}

/**
 * Runs a console program in its own visible console window, waits for that window to close, and
 * returns the program's exit code. `null` means the window was closed before the program finished.
 * A console program started without a console of its own has nothing to read or write and quits
 * at once, which is why this is needed for text-mode installers.
 */
export async function runInConsoleWindow(
  file: string,
  args: string[],
  opts: { title: string; workDir: string; pauseAtEnd?: boolean },
): Promise<number | null> {
  fs.mkdirSync(opts.workDir, { recursive: true });
  const batch = path.join(opts.workDir, 'run-installer.cmd');
  const codeFile = path.join(opts.workDir, 'exit-code.txt');
  fs.rmSync(codeFile, { force: true });

  const lines = [
    '@echo off',
    'chcp 65001 >nul', // so a user name with accented letters in a path still works
    `${batchQuote(file)} ${args.map(batchArg).join(' ')}`.trimEnd(),
    'set UMM_CODE=%errorlevel%',
    // Redirect first: "echo 0> file" would be read as redirecting handle 0 instead of writing the digit.
    `>${batchQuote(codeFile)} echo %UMM_CODE%`,
  ];
  if (opts.pauseAtEnd !== false) {
    lines.push('echo.', 'echo The installer has finished. Press any key to close this window.', 'pause >nul');
  }
  lines.push('exit /b %UMM_CODE%');
  fs.writeFileSync(batch, lines.join('\r\n') + '\r\n', 'utf8');

  const title = opts.title.replace(/["&|<>^%]/g, '');
  await new Promise<void>((resolve, reject) => {
    // `start /wait` gives the program a fresh console window and waits until it closes. The shell is
    // named explicitly with /c: `start` on a bare .cmd file would use `cmd /K`, which leaves a prompt
    // open after the batch file ends. (/s makes cmd strip the outer pair of quotes.)
    const child = spawn('cmd.exe', ['/d', '/c', 'start', `"${title}"`, '/wait', 'cmd', '/d', '/s', '/c', `""${batch}""`], {
      windowsVerbatimArguments: true,
      windowsHide: true, // hides only this helper; the started window is shown normally
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', () => resolve());
  });

  try {
    const code = parseInt(fs.readFileSync(codeFile, 'utf8').trim(), 10);
    return Number.isNaN(code) ? null : code;
  } catch {
    return null;
  }
}
