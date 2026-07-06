import pc from 'picocolors';

export const log = {
  info(msg: string): void {
    console.log(msg);
  },
  ok(msg: string): void {
    console.log(`${pc.green('✔')} ${msg}`);
  },
  warn(msg: string): void {
    console.log(`${pc.yellow('▲')} ${msg}`);
  },
  fail(msg: string): void {
    console.error(`${pc.red('✖')} ${msg}`);
  },
  title(msg: string): void {
    console.log(`\n${pc.bold(msg)}`);
  },
  dim(msg: string): void {
    console.log(pc.dim(msg));
  },
};
