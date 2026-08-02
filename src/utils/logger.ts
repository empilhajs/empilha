export type Logger = {
  info(details: unknown, message?: string): void;
  warn(details: unknown, message?: string): void;
  error(details: unknown, message?: string): void;
};

const consoleLogger: Logger = {
  info: (details, message) => console.info(message ?? "", details),
  warn: (details, message) => console.warn(message ?? "", details),
  error: (details, message) => console.error(message ?? "", details),
};

/** Logger configurável por aplicação, com console como fallback. */
export class ApplicationLogger implements Logger {
  private target: Logger = consoleLogger;

  configure(logger: Logger): void {
    this.target = logger;
  }

  info(details: unknown, message?: string): void {
    this.target.info(details, message);
  }

  warn(details: unknown, message?: string): void {
    this.target.warn(details, message);
  }

  error(details: unknown, message?: string): void {
    this.target.error(details, message);
  }
}

/** Fallback usado por utilitários que ainda não recebem um logger de aplicação. */
export function logFrameworkError(message: string, error: unknown): void {
  consoleLogger.error(error, message);
}
