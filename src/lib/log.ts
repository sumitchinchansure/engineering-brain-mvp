import chalk from 'chalk';

export const logInfo = (msg: string): void => console.log(chalk.cyan(msg));
export const logSuccess = (msg: string): void => console.log(chalk.green(msg));
export const logWarn = (msg: string): void => console.log(chalk.yellow(msg));
export const logError = (msg: string): void => console.error(chalk.red(msg));
export const logLink = (msg: string): void => console.log(chalk.blue(msg));
