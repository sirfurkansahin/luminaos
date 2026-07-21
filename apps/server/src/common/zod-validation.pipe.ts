import { ValidationError } from '@luminaos/shared';

import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Generic NestJS pipe that validates a request body against a given zod
 * schema. On failure it throws `ValidationError` (400) with the zod issues
 * array attached as `details`, rather than letting NestJS's default
 * `BadRequestException` shape leak out — every request-lifecycle failure in
 * this codebase goes through `packages/shared/errors`.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationError('Validation failed', result.error.issues);
    }

    return result.data;
  }
}
