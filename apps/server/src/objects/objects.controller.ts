import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { LuminaObject } from '@luminaos/core-objects';
import { UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createObjectSchema } from './dto/create-object.schema.js';
import { renameObjectSchema } from './dto/rename-object.schema.js';
import { ObjectsService } from './objects.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateObjectInput } from './dto/create-object.schema.js';
import type { RenameObjectInput } from './dto/rename-object.schema.js';
import type { Request } from 'express';

/**
 * Every route under this controller already takes a `:workspaceId`, so
 * (unlike `WorkspacesController`, whose `POST /` has no workspace yet to
 * check membership against) the full guard stack applies uniformly at the
 * class level.
 */
@Controller('workspaces/:workspaceId/objects')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(createObjectSchema)) body: CreateObjectInput,
    @Req() req: Request,
  ): Promise<{ object: LuminaObject }> {
    const actor = this.requireActor(req);

    const object = await this.objectsService.create(workspaceId, actor, {
      objectType: body.objectType,
      title: body.title,
    });

    return { object };
  }

  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ): Promise<{ objects: LuminaObject[] }> {
    const objects = await this.objectsService.list(workspaceId);

    return { objects };
  }

  @Get(':objectId')
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
  ): Promise<{ object: LuminaObject }> {
    const object = await this.objectsService.get(workspaceId, objectId);

    return { object };
  }

  @Patch(':objectId')
  async rename(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Body(new ZodValidationPipe(renameObjectSchema)) body: RenameObjectInput,
    @Req() req: Request,
  ): Promise<{ object: LuminaObject }> {
    const actor = this.requireActor(req);

    const object = await this.objectsService.rename(workspaceId, objectId, actor, {
      title: body.title,
    });

    return { object };
  }

  @Post(':objectId/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Req() req: Request,
  ): Promise<{ object: LuminaObject }> {
    const actor = this.requireActor(req);

    const object = await this.objectsService.archive(workspaceId, objectId, actor);

    return { object };
  }

  @Post(':objectId/restore')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Req() req: Request,
  ): Promise<{ object: LuminaObject }> {
    const actor = this.requireActor(req);

    const object = await this.objectsService.restore(workspaceId, objectId, actor);

    return { object };
  }

  @Delete(':objectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async softDelete(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = this.requireActor(req);

    await this.objectsService.softDelete(workspaceId, objectId, actor);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `WorkspacesController`'s handling of the same guarantee.
   */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }
}
