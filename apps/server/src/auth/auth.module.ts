import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MeController } from './me.controller.js';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionService } from './session.service.js';
import { DbModule } from '../db/db.module.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

// `WorkspaceMembershipService` is provided here directly (not via importing
// `WorkspacesModule`) to avoid a module import cycle: `WorkspacesModule`
// already imports `AuthModule` (for `SessionAuthGuard`). The service itself
// only depends on `DATABASE_CONNECTION` (already available via `DbModule`),
// so this is a second, independent instance — harmless, since the service
// is stateless. See `me.controller.ts` (F2-T3b `GET /me` workspaces
// expansion).
@Module({
  imports: [DbModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, SessionService, SessionAuthGuard, WorkspaceMembershipService],
  exports: [SessionAuthGuard, SessionService],
})
export class AuthModule {}
