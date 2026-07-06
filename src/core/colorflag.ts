/**
 * Must be the FIRST import of the entry point: picocolors decides color
 * support once at module load, so --no-color has to become NO_COLOR in the
 * environment before any module that imports picocolors is evaluated.
 */
if (process.argv.includes('--no-color')) process.env.NO_COLOR = '1';
