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

import type { SavedView } from '@luminaos/core-objects';
import { ForbiddenError, UnauthorizedError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { createSavedViewSchema } from './dto/create-saved-view.schema.js';
import { listSavedViewsQuerySchema } from './dto/list-saved-views.schema.js';
import { updateSavedViewSchema } from './dto/update-saved-view.schema.js';
import { SavedViewsService } from './saved-views.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { CreateSavedViewInput } from './dto/create-saved-view.schema.js';
import type { ListSavedViewsQuery } from './dto/list-saved-views.schema.js';
import type { UpdateSavedViewInput } from './dto/update-saved-view.schema.js';
import type { UpdateSavedViewCommandInput } from './saved-views.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * Every route under this controller already takes a `:workspaceId`, so the
 * full guard stack applies uniformly at the class level, mirroring
 * `RelationsController`/`FieldsController`. Unlike `FieldsController`'s
 * class-level admin-gated routes, this controller's admin-vs-owner gating is
 * NOT uniform per route — it depends on the request's own `shared` flag
 * (create) or the target saved view's `ownerId` (update/delete) — so it is
 * checked inside `SavedViewsService`, not here (see that service's own doc
 * comment on the TOCTOU reasoning).
 */
@Controller('workspaces/:workspaceId/views')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class SavedViewsController {
  constructor(private readonly savedViewsService: SavedViewsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body(new ZodValidationPipe(createSavedViewSchema)) body: CreateSavedViewInput,
    @Req() req: Request,
  ): Promise<{ savedView: SavedView }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const savedView = await this.savedViewsService.create(workspaceId, actor, callerRole, {
      objectType: body.objectType,
      name: body.name,
      icon: body.icon,
      viewType: body.viewType,
      querySpec: body.querySpec,
      ...(body.dateField !== undefined ? { dateField: body.dateField } : {}),
      ...(body.startField !== undefined ? { startField: body.startField } : {}),
      ...(body.endField !== undefined ? { endField: body.endField } : {}),
      shared: body.shared,
    });

    return { savedView };
  }

  /**
   * `?objectType=` is required (spec AC#2's visibility rule is scoped per
   * object type, matching `FieldsController`'s
   * `:objectType`-scoped-by-URL-segment reasoning, just via a query param
   * here since a saved view is not itself URL-scoped by object type). Not
   * admin-gated — any workspace member (including guest) may list.
   */
  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query(new ZodValidationPipe(listSavedViewsQuerySchema)) query: ListSavedViewsQuery,
    @Req() req: Request,
  ): Promise<{ savedViews: SavedView[] }> {
    const actor = this.requireActor(req);

    const savedViews = await this.savedViewsService.list(workspaceId, query.objectType, actor.id);

    return { savedViews };
  }

  @Patch(':savedViewId')
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('savedViewId') savedViewId: string,
    @Body(new ZodValidationPipe(updateSavedViewSchema)) body: UpdateSavedViewInput,
    @Req() req: Request,
  ): Promise<{ savedView: SavedView }> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    const savedView = await this.savedViewsService.update(
      workspaceId,
      savedViewId,
      actor,
      callerRole,
      this.toUpdateInput(body),
    );

    return { savedView };
  }

  @Delete(':savedViewId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('savedViewId') savedViewId: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = this.requireActor(req);
    const callerRole = this.requireRole(req);

    await this.savedViewsService.delete(workspaceId, savedViewId, actor, callerRole);
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `RelationsController.requireActor`'s exact reasoning.
   */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }

  /**
   * `WorkspaceMembershipGuard` always sets `req.membership` before any
   * handler here runs — fail closed (403) rather than assert it away, same
   * reasoning as `FieldsController.requireRole`.
   */
  private requireRole(req: Request): MembershipRole {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }

  /**
   * Builds a `SavedViewsService.update` input that only carries the keys
   * the caller actually supplied — `exactOptionalPropertyTypes` means a
   * present-but-`undefined` key must be omitted entirely rather than
   * assigned `undefined`, mirroring `FieldsController.toUpdateInput`'s exact
   * reasoning.
   */
  private toUpdateInput(body: UpdateSavedViewInput): UpdateSavedViewCommandInput {
    const input: UpdateSavedViewCommandInput = {};

    if (body.name !== undefined) {
      input.name = body.name;
    }

    if (body.icon !== undefined) {
      input.icon = body.icon;
    }

    if (body.querySpec !== undefined) {
      input.querySpec = body.querySpec;
    }

    if (body.dateField !== undefined) {
      input.dateField = body.dateField;
    }

    if (body.startField !== undefined) {
      input.startField = body.startField;
    }

    if (body.endField !== undefined) {
      input.endField = body.endField;
    }

    return input;
  }
}
