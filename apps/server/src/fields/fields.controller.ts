import {
  Body,
  Controller,
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

import { isKnownObjectType } from '@luminaos/core-objects';
import type { FieldDefinition, ObjectType, Role } from '@luminaos/core-objects';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@luminaos/shared';
import type { Actor } from '@luminaos/shared';

import { defineFieldSchema } from './dto/define-field.schema.js';
import { updateFieldSchema } from './dto/update-field.schema.js';
import { FieldDefinitionsService } from './field-definitions.service.js';
import { SessionAuthGuard } from '../auth/session-auth.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { hasAtLeastRole } from '../workspaces/membership.util.js';
import { WorkspaceMembershipGuard } from '../workspaces/workspace-membership.guard.js';

import type { DefineFieldInput } from './dto/define-field.schema.js';
import type { UpdateFieldInput } from './dto/update-field.schema.js';
import type { UpdateFieldDefinitionInput } from './field-definitions.service.js';
import type { MembershipRole } from '../workspaces/membership.util.js';
import type { Request } from 'express';

/**
 * Every route under this controller already takes a `:workspaceId`, so the
 * full guard stack applies uniformly at the class level — same reasoning as
 * `ObjectsController`. `POST`/`PATCH`/archive additionally require
 * `admin`+ (checked inline via `requireAdmin`, per the plan's documented
 * design note "admin ve üzeri şema yönetebilir" — not a separate guard
 * class). `GET` is open to any workspace member.
 */
@Controller('workspaces/:workspaceId/object-types/:objectType/fields')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class FieldsController {
  constructor(private readonly fieldDefinitionsService: FieldDefinitionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async define(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectType') objectTypeParam: string,
    @Body(new ZodValidationPipe(defineFieldSchema)) body: DefineFieldInput,
    @Req() req: Request,
  ): Promise<{ fieldDefinition: FieldDefinition }> {
    const objectType = this.requireObjectType(objectTypeParam);
    this.requireAdmin(req);
    const actor = this.requireActor(req);

    const fieldDefinition = await this.fieldDefinitionsService.define(
      workspaceId,
      objectType,
      actor,
      {
        key: body.key,
        label: body.label,
        fieldType: body.fieldType,
        config: body.config,
        defaultValue: body.defaultValue,
        permissions: body.permissions,
      },
    );

    return { fieldDefinition };
  }

  @Get()
  async list(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectType') objectTypeParam: string,
    @Req() req: Request,
  ): Promise<{ fieldDefinitions: FieldDefinition[] }> {
    const objectType = this.requireObjectType(objectTypeParam);
    const callerRole = this.requireRole(req);

    const fieldDefinitions = await this.fieldDefinitionsService.list(
      workspaceId,
      objectType,
      callerRole,
    );

    return { fieldDefinitions };
  }

  @Patch(':fieldDefinitionId')
  async update(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectType') objectTypeParam: string,
    @Param('fieldDefinitionId') fieldDefinitionId: string,
    @Body(new ZodValidationPipe(updateFieldSchema)) body: UpdateFieldInput,
    @Req() req: Request,
  ): Promise<{ fieldDefinition: FieldDefinition }> {
    const objectType = this.requireObjectType(objectTypeParam);
    this.requireAdmin(req);
    const actor = this.requireActor(req);

    const fieldDefinition = await this.fieldDefinitionsService.update(
      workspaceId,
      objectType,
      fieldDefinitionId,
      actor,
      this.toUpdateInput(body),
    );

    return { fieldDefinition };
  }

  @Post(':fieldDefinitionId/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('objectType') objectTypeParam: string,
    @Param('fieldDefinitionId') fieldDefinitionId: string,
    @Req() req: Request,
  ): Promise<{ fieldDefinition: FieldDefinition }> {
    const objectType = this.requireObjectType(objectTypeParam);
    this.requireAdmin(req);
    const actor = this.requireActor(req);

    const fieldDefinition = await this.fieldDefinitionsService.archive(
      workspaceId,
      objectType,
      fieldDefinitionId,
      actor,
    );

    return { fieldDefinition };
  }

  /**
   * `:objectType` must be one of `task`/`doc`/`note`. DESIGN DECISION
   * (pinned by `field-definitions.integration.test.ts`): an unknown value is
   * a 400 (`ValidationError`) — the route itself exists, only the path
   * segment's value is invalid, so it is treated analogously to a DTO
   * validation failure rather than a 404.
   */
  private requireObjectType(objectType: string): ObjectType {
    if (!isKnownObjectType(objectType)) {
      throw new ValidationError('unknown object type', { objectType });
    }

    return objectType;
  }

  /**
   * `WorkspaceMembershipGuard` always sets `req.membership` before any
   * handler here runs (it runs after `SessionAuthGuard`, before this
   * controller) — fail closed (403) rather than assert it away. `role` is
   * read from the `memberships` table's `membership_role` Postgres enum
   * (`owner`/`admin`/`member`/`guest`), so narrowing the guard's `string`
   * field to `MembershipRole` here is safe.
   */
  private requireAdmin(req: Request): void {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role || !hasAtLeastRole(role, 'admin')) {
      throw new ForbiddenError();
    }
  }

  /**
   * Returns the caller's membership role for `canViewField` filtering on
   * `list`. `MembershipRole` (server) and `Role` (`@luminaos/core-objects`)
   * are structurally identical 4-value string unions — see the plan's
   * "Keşiften çıkan kritik gerçekler" note — so this cast is a no-op, not a
   * real transformation. Fails closed (403) if `WorkspaceMembershipGuard`
   * somehow didn't run, same reasoning as `requireAdmin`.
   */
  private requireRole(req: Request): Role {
    const role = req.membership?.role as MembershipRole | undefined;

    if (!role) {
      throw new ForbiddenError();
    }

    return role;
  }

  /**
   * `SessionAuthGuard` always sets `req.user` before any handler here runs —
   * fail closed (401) rather than assert it away, mirroring
   * `ObjectsController`'s handling of the same guarantee.
   */
  private requireActor(req: Request): Actor {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    return { type: 'user', id: req.user.id };
  }

  /**
   * Builds a `FieldDefinitionsService.update` input that only carries the
   * keys the caller actually supplied. `UpdateFieldDefinitionInput`'s
   * optional fields are typed strictly (no explicit `undefined`, per this
   * project's `exactOptionalPropertyTypes`), so a present-but-`undefined`
   * key must be omitted entirely rather than assigned `undefined` — this
   * also matches the domain layer's own `undefined`-means-"unchanged"
   * convention (`updateField`'s own handling of `UpdateFieldInput`).
   */
  private toUpdateInput(body: UpdateFieldInput): UpdateFieldDefinitionInput {
    const input: UpdateFieldDefinitionInput = {};

    if (body.label !== undefined) {
      input.label = body.label;
    }

    if (body.config !== undefined) {
      input.config = body.config;
    }

    if (body.defaultValue !== undefined) {
      input.defaultValue = body.defaultValue;
    }

    if (body.permissions !== undefined) {
      input.permissions = body.permissions;
    }

    return input;
  }
}
