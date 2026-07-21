import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MeController } from './me.controller.js';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionService } from './session.service.js';
import { DbModule } from '../db/db.module.js';

@Module({
  imports: [DbModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, SessionService, SessionAuthGuard],
  exports: [SessionAuthGuard, SessionService],
})
export class AuthModule {}
