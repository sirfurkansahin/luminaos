import { Controller, Get } from '@nestjs/common';

import type { HealthCheckPayload } from '@luminaos/shared';

import { HealthService } from './health/health.service.js';

@Controller()
export class AppController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async getHealth(): Promise<HealthCheckPayload> {
    return this.healthService.check();
  }
}
