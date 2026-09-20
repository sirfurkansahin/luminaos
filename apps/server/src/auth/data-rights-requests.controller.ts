import { Controller, Get, Post, UseGuards } from '@nestjs/common';

import { UnauthorizedError } from '@luminaos/shared';

import { CurrentUser } from './current-user.decorator.js';
import { DataRightsRequestsService } from './data-rights-requests.service.js';
import { SessionAuthGuard } from './session-auth.guard.js';

import type { DataRightsRequest } from '../db/schema/data-rights-requests.js';

interface CurrentSessionUser {
  id: string;
  email: string;
}

function publicRequest(request: DataRightsRequest | null) {
  if (!request) return null;
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    requestedAt: request.requestedAt,
    resolvedAt: request.resolvedAt,
  };
}

@Controller('me/data-rights-requests')
@UseGuards(SessionAuthGuard)
export class DataRightsRequestsController {
  constructor(private readonly requestsService: DataRightsRequestsService) {}

  @Get()
  async getLatest(@CurrentUser() currentUser: CurrentSessionUser | undefined) {
    if (!currentUser) throw new UnauthorizedError();
    return { request: publicRequest(await this.requestsService.getLatestForUser(currentUser.id)) };
  }

  @Post('deletion')
  async createDeletion(@CurrentUser() currentUser: CurrentSessionUser | undefined) {
    if (!currentUser) throw new UnauthorizedError();
    return {
      request: publicRequest(await this.requestsService.createDeletionRequest(currentUser.id)),
    };
  }
}
