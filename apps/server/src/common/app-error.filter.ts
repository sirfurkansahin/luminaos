import { Catch, Logger } from '@nestjs/common';

import { AppError } from '@luminaos/shared';

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Global catch-all: maps every `AppError` thrown anywhere in a request's
 * lifecycle to a consistent `{ error: { code, message } }` HTTP response
 * using the error's own `statusCode`, and maps anything else (a raw `pg`
 * driver error, a bug, ...) to a generic `500`.
 *
 * `@Catch()` with no argument (rather than `@Catch(AppError)`) is
 * deliberate: without it, a non-`AppError` exception falls through to
 * Nest's own default filter, which logs the exception's full
 * message/stack — and driver-level errors like a Postgres unique-constraint
 * violation embed the offending row's data directly in their message (e.g.
 * `Key (email)=(user@example.com) already exists.`), which would leak PII
 * into logs. This filter never logs or forwards the raw message/stack for
 * anything that isn't an `AppError` — only its constructor name plus the
 * request method/path.
 *
 * For the `AppError` branch, it deliberately logs only the error
 * code/message/request path — never the request body, headers, or any
 * cookie/session value — so a bug that throws an `AppError` while handling
 * a login/register request can never leak a plaintext password or session
 * token into the logs (CLAUDE.md: never log user data or secrets).
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof AppError) {
      this.logger.warn(
        `${exception.code} on ${request.method} ${request.path}: ${exception.message}`,
      );

      response.status(exception.statusCode).json({
        error: {
          code: exception.code,
          message: exception.message,
        },
      });
      return;
    }

    // Unknown exception shape: never forward or log its message/stack (it
    // may embed PII, e.g. a Postgres constraint-violation message), and
    // never leak internal detail to the client either — a generic 500.
    const exceptionClassName =
      exception instanceof Error ? exception.constructor.name : typeof exception;

    this.logger.error(`Unhandled ${exceptionClassName} on ${request.method} ${request.path}`);

    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  }
}
