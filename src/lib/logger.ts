import type { BaseLogger } from 'pino';

import appInsights from 'applicationinsights';
import pino from 'pino';

import env from '@/env';

/**
 * Extends Pino's BaseLogger with a metric() method for emitting named numeric
 * metrics with optional dimensions. Production sends them to Application
 * Insights as custom metrics; development prints a visible log line.
 */
interface AppLogger extends BaseLogger {
  metric: (name: string, value: number, dimensions?: Record<string, string>) => void;
}

// Locally defined SeverityLevel enum matching Application Insights
enum SeverityLevel {
  Verbose = 0,
  Information = 1,
  Warning = 2,
  Error = 3,
  Critical = 4,
}

class AppInsightsLogger implements BaseLogger {
  level: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' = 'info';

  constructor(private client: appInsights.TelemetryClient) {}

  info(...args: any[]): void {
    const { message, properties } = this.parseArgs(args);
    if (this.client) {
      this.client.trackTrace({ message, severity: SeverityLevel.Information as any, properties });
    }

    // eslint-disable-next-line no-console -- App Insights traces must also remain visible in process logs.
    console.info(message);
  }

  warn(...args: any[]): void {
    const { message, properties } = this.parseArgs(args);
    if (this.client) {
      this.client.trackTrace({ message, severity: SeverityLevel.Warning as any, properties });
    }

    console.warn(message);
  }

  error(...args: any[]): void {
    const { message, properties } = this.parseArgs(args);
    if (this.client) {
      if (typeof message === 'string' && message.includes('Error:')) {
        // Try to parse if it's an error string
        const error = new Error(message);
        this.client.trackException({ exception: error, properties });
        console.error(message);
      } else {
        this.client.trackTrace({
          message: String(message),
          severity: SeverityLevel.Error as any,
          properties,
        });
        console.error(message);
      }
    } else {
      console.error(message);
    }
  }

  debug(...args: any[]): void {
    const { message, properties } = this.parseArgs(args);
    if (this.client) {
      this.client.trackTrace({ message, severity: SeverityLevel.Verbose as any, properties });
    }
    // eslint-disable-next-line no-console -- App Insights debug traces must also remain visible in process logs.
    console.debug(message);
  }

  trace(...args: any[]): void {
    const { message, properties } = this.parseArgs(args);
    if (this.client) {
      this.client.trackTrace({ message, severity: SeverityLevel.Verbose as any, properties });
    }
    // eslint-disable-next-line no-console -- App Insights trace output must also remain visible in process logs.
    console.trace(message);
  }

  fatal(...args: any[]): void {
    const { message, properties } = this.parseArgs(args);
    if (this.client)
      this.client.trackTrace({ message, severity: SeverityLevel.Critical as any, properties });
    console.error(message);
  }

  silent(): void {}

  metric(name: string, value: number, dimensions?: Record<string, string>): void {
    if (this.client) {
      this.client.trackMetric({
        name,
        value,
        properties: dimensions,
      });
    }

    // Keep production metrics visible in worker stdout alongside Application Insights telemetry.
    // eslint-disable-next-line no-console -- Operational metrics need a local diagnostic fallback.
    console.info(`[metric] ${name}=${value}`, dimensions ? JSON.stringify(dimensions) : '');
  }

  private parseArgs(args: any[]): { message: string; properties?: Record<string, any> } {
    if (args.length === 0) {
      return { message: '' };
    }

    let obj: Record<string, any> | null = null;
    let msg: any;
    let formatParams: any[] = [];

    if (args.length === 1) {
      const firstArg = args[0];
      if (typeof firstArg === 'object' && firstArg !== null) {
        if (firstArg.method && firstArg.headers && firstArg.socket) {
          obj = { ...firstArg, _httpRequest: true };
          msg = null;
        } else if (typeof firstArg.setHeader === 'function') {
          obj = { ...firstArg, _httpResponse: true };
          msg = null;
        } else {
          obj = firstArg;
          msg = null;
        }
      } else {
        obj = null;
        msg = firstArg;
      }
    } else {
      const firstArg = args[0];
      if (typeof firstArg === 'object' && firstArg !== null) {
        obj = firstArg;
        if (firstArg.method && firstArg.headers && firstArg.socket) {
          obj = { ...firstArg, _httpRequest: true };
        } else if (typeof firstArg.setHeader === 'function') {
          obj = { ...firstArg, _httpResponse: true };
        }

        if (obj === null && args.length === 1) {
          formatParams = [null];
          msg = undefined;
        } else {
          msg = args[1];
          formatParams = args.slice(2);
        }
      } else {
        obj = null;
        msg = firstArg;
        formatParams = args.slice(1);
      }
    }

    let finalMessage: string;
    if (msg === undefined && formatParams.length === 0 && obj === null) {
      finalMessage = '';
    } else if (msg === undefined && obj !== null) {
      finalMessage = JSON.stringify(obj);
    } else {
      finalMessage = this.formatMessage(msg, formatParams);
    }

    let finalProperties: Record<string, any> | undefined;
    if (obj !== null && typeof obj === 'object') {
      finalProperties = { ...obj };

      if (formatParams.length > 0) {
        finalProperties._formatParams = formatParams;
      }
    } else if (formatParams.length > 0) {
      finalProperties = { _formatParams: formatParams };
    }

    return {
      message: finalMessage || 'No message provided',
      properties: finalProperties,
    };
  }

  private formatMessage(msg: any, formatParams: any[]): string {
    if (msg === null || msg === undefined) {
      return '';
    }

    const message = String(msg);

    if (formatParams.length === 0) {
      return message;
    }

    let paramIndex = 0;
    const formatted = message.replace(/%[sdjoO%]/g, (match) => {
      if (match === '%%') return '%';
      if (paramIndex >= formatParams.length) return match;

      const param = formatParams[paramIndex++];

      switch (match) {
        case '%s':
          return String(param);
        case '%d':
          return String(Number(param));
        case '%j':
          return JSON.stringify(param);
        case '%o':
        case '%O':
          return JSON.stringify(param);
        default:
          return String(param);
      }
    });

    if (paramIndex < formatParams.length) {
      const remaining = formatParams.slice(paramIndex);
      return `${formatted} ${remaining
        .map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p)))
        .join(' ')}`;
    }

    return formatted;
  }
}

function createLogger(): AppLogger {
  if (env.NODE_ENV === 'production') {
    const connectionString = env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    if (connectionString) {
      appInsights.setup(connectionString).start();
    } else {
      console.warn('Application Insights connection string not set. Telemetry will not be sent.');
    }

    const client = appInsights.defaultClient;

    return new AppInsightsLogger(client);
  }

  // Use Pino in development — attach metric() so dev runs show the same
  // metric names production alerts on, as a visible log line.
  const pinoLogger = pino({ level: 'debug', transport: { target: 'pino-pretty' } });
  return Object.assign(pinoLogger, {
    metric(name: string, value: number, dimensions?: Record<string, string>) {
      pinoLogger.info({ metric: name, value, dimensions }, `[metric] ${name}=${value}`);
    },
  }) as AppLogger;
}

export const logger: AppLogger = createLogger();
