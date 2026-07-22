import { Inject, Injectable } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';
import { catchError, tap } from 'rxjs';

import { TRACER } from './tracing.module.js';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Tracer } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Express's own `Request['route']` typing is effectively untyped (`any`) in
 * `@types/express-serve-static-core`, since its exact shape depends on
 * routing internals this app never touches directly. This narrows it down to
 * just the one field (`path`) actually needed here, without letting `any`
 * propagate — the request's real, matched-route path when Express has
 * attached one, falling back to the raw request path otherwise (e.g. a 404
 * with no matched route).
 */
function getRoutePath(request: Request): string {
  const route: unknown = (request as { route?: unknown }).route;

  if (
    typeof route === 'object' &&
    route !== null &&
    'path' in route &&
    typeof route.path === 'string'
  ) {
    return (route as { path: string }).path;
  }

  return request.path;
}

/**
 * Global `APP_INTERCEPTOR` (registered in `app.module.ts`) that wraps every
 * HTTP request in a manually-created span — per the approved plan
 * (`giggly-brewing-moore.md`, Kapsam 3): "elle (manuel) span'ler,
 * auto-instrumentation DEĞİL" (Node ESM auto-instrumentation needs
 * `--experimental-loader`, which this repo's `nest build`/`nest start
 * --watch` has no reliable hook to inject).
 *
 * Attribute names are the REAL exported constants from the installed
 * `@opentelemetry/semantic-conventions@1.43.0` (confirmed by reading that
 * package's `stable_attributes.js`), not guessed string literals:
 * `ATTR_HTTP_REQUEST_METHOD` ('http.request.method'), `ATTR_HTTP_ROUTE`
 * ('http.route'), `ATTR_HTTP_RESPONSE_STATUS_CODE`
 * ('http.response.status_code').
 *
 * The final response status code is only known for certain once the
 * response has actually finished writing (Nest/Express set `res.statusCode`
 * — including any later override by `AppErrorFilter` on the error path —
 * AFTER this interceptor's own `tap`/`catchError` operators run, not before).
 * Rather than recording a possibly-stale/default status code synchronously,
 * this listens for the underlying `http.ServerResponse`'s `'finish'` event
 * (or reads `res.statusCode` immediately if the response has already
 * finished by the time we get there) to record the true final status before
 * ending the span.
 */
@Injectable()
export class HttpTracingInterceptor implements NestInterceptor {
  constructor(@Inject(TRACER) private readonly tracer: Tracer) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const route = getRoutePath(request);
    const span = this.tracer.startSpan(`${request.method} ${route}`);
    span.setAttribute(ATTR_HTTP_REQUEST_METHOD, request.method);
    span.setAttribute(ATTR_HTTP_ROUTE, route);

    const finishSpan = (): void => {
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.statusCode);
      span.end();
    };

    const finishSpanWhenResponseEnds = (): void => {
      if (response.writableEnded) {
        finishSpan();
      } else {
        response.once('finish', finishSpan);
      }
    };

    return next.handle().pipe(
      tap(() => {
        finishSpanWhenResponseEnds();
      }),
      catchError((error: unknown) => {
        span.setStatus({ code: SpanStatusCode.ERROR });
        finishSpanWhenResponseEnds();
        throw error;
      }),
    );
  }
}
