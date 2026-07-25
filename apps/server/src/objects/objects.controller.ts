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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { LuminaObject, Role } from '@luminaos/core-objects';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createObjectSchema } from './dto/create-object.schema.js';
import { listObjectsQuerySchema } from './dto/list-objects.schema.js';
import { renameObjectSchema } from './dto/rename-object.schema.js';
import { setFieldValuesSchema } from './dto/set-field-values.schema.js';
import { ObjectsService } from './objects.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateObjectInput } from './dto/create-object.schema.js';
import type { ListObjectsQuery } from './dto/list-objects.schema.js';
import type { RenameObjectInput } from './dto/rename-object.schema.js';
import type { SetFieldValuesInput } from './dto/set-field-values.schema.js';
import type { ObjectWithFieldValues } from './objects.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
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
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const object = await this.objectsService.create(
      workspaceId,
      actor,
      {
        objectType: body.objectType,
        title: body.title,
      },
      callerRole,
    );

    return { object };
  }

  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query(new ZodValidationPipe(listObjectsQuerySchema)) query: ListObjectsQuery,
    @Req() req: Request,
  ): Promise<{ objects: ObjectWithFieldValues[]; aggregates?: Record<string, number | null> }> {
    const callerRole = this.requireRole(req);
    const { objects, aggregates } = await this.objectsService.list(
      workspaceId,
      callerRole,
      query.aggregate,
    );

    return { objects, ...(aggregates ? { aggregates } : {}) };
  }

  @Get(':objectId')
  async get(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const callerRole = this.requireRole(req);
    const object = await this.objectsService.get(workspaceId, objectId, callerRole);

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

  @Patch(':objectId/fields')
  async setFieldValues(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Body(new ZodValidationPipe(setFieldValuesSchema)) body: SetFieldValuesInput,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const entries = Object.entries(body.values).map(([fieldKey, value]) => ({ fieldKey, value }));

    const object = await this.objectsService.setFieldValues(
      workspaceId,
      objectId,
      actor,
      callerRole,
      entries,
    );

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

  /**
   * Mirrors `archive`/`restore`'s action-route style exactly. Same guard
   * stack as every other object mutation route (no extra role gating) --
   * `ObjectsService.refreshAIField` itself enforces the "must be able to
   * view this field" visibility check (F1-T5 PR-C).
   */
  @Post(':objectId/fields/:fieldKey/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshAIField(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectId') objectId: string,
    @Param('fieldKey') fieldKey: string,
    @Req() req: Request,
  ): Promise<{ object: ObjectWithFieldValues }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const object = await this.objectsService.refreshAIField(
      workspaceId,
      objectId,
      fieldKey,
      actor,
      callerRole,
    );

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

  /**
   * Returns the caller's membership role for `fieldValues` filtering on
   * `get`/`list`/`create` and edit-permission checks on `setFieldValues`.
   * `MembershipRole` (server) and `Role` (`@luminaos/core-objects`) are
   * structurally identical 4-value string unions (per the F1-T2 plan), so
   * this cast is a no-op, not a real transformation — mirrors
   * `FieldsController.requireRole`'s exact reasoning. Fails closed (403) if
   * `WorkspaceMembershipGuard` somehow didn't run, same reasoning as
   * `requireActor`'s 401 fallback.
   */
  private requireRole(req: Request): Role {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }
}
