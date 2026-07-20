import { Controller, Get } from '@nestjs/common';
import { buildHealthCheckPayload, type HealthCheckPayload } from '@luminaos/shared';

@Controller()
export class AppController {
  @Get('health')
  getHealth(): HealthCheckPayload {
    return buildHealthCheckPayload();
  }
}
