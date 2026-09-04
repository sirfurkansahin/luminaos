import { Module } from '@nestjs/common';

import { SkillRegistry } from '@luminaos/skill-sdk';

import {
  buildAnswerQuestionSkill,
  buildListCommandProposalsSkill,
  buildParseCommandSkill,
  buildProposeActionsFromMeetingSkill,
  buildRunTriggerSuggestionAnalysisSkill,
  AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM,
} from './ai-command-skills.js';
import {
  buildGetObjectContextSkill,
  buildListCachedCalendarEventsSkill,
  buildSearchConnectedSourcesSkill,
  CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PUBLIC_KEY_PEM,
} from './context-search-calendar-skills.js';
import {
  buildGenerateNextRecurrenceSkill,
  buildGetMeetingDetailsSkill,
  buildInviteMeetingBotSkill,
  MEETING_RECURRENCE_SKILLS_SIGNING_PUBLIC_KEY_PEM,
} from './meeting-recurrence-skills.js';
import {
  buildAddChecklistItemSkill,
  buildCreateObjectSkill,
  buildGetObjectSkill,
  buildQueryObjectsSkill,
  buildRefreshAIFieldSkill,
  buildScheduleTimeBlockSkill,
  buildSetFieldValuesSkill,
  buildSetRecurrenceRuleSkill,
  buildToggleChecklistItemSkill,
  OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM,
} from './object-skills.js';
import { SKILL_REGISTRY, SkillExecutionService } from './skill-execution.service.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { CalendarEventsService } from '../calendar/calendar-events.service.js';
import { CalendarModule } from '../calendar/calendar.module.js';
import { CommandsModule } from '../commands/commands.module.js';
import { CommandsService } from '../commands/commands.service.js';
import { ContextModule } from '../context/context.module.js';
import { ContextService } from '../context/context.service.js';
import { MeetingsService } from '../notetaker/meetings.service.js';
import { NotetakerModule } from '../notetaker/notetaker.module.js';
import { ObjectsModule } from '../objects/objects.module.js';
import { ObjectsService } from '../objects/objects.service.js';
import { QAModule } from '../qa/qa.module.js';
import { QAService } from '../qa/qa.service.js';
import { TaskRecurrenceService } from '../recurrence/task-recurrence.service.js';
import { ConnectedSearchService } from '../search/connected-search.service.js';
import { SearchModule } from '../search/search.module.js';
import { TriggerSuggestionsModule } from '../trigger-suggestions/trigger-suggestions.module.js';
import { TriggerSuggestionsService } from '../trigger-suggestions/trigger-suggestions.service.js';

/**
 * F3-T2 PR2/PR3 (ADR-0036 Karar f): wires `SkillExecutionService` -- the ONE
 * integration point between `@luminaos/skill-sdk`'s `SkillRegistry` and
 * `AgentRuntimeModule`'s `AgentPermissionManifestsService`/
 * `AgentResourceLimitsService` -- into Nest DI. `SkillRegistry` is not a
 * zero-arg-constructible-by-Nest class in any special way, but it IS
 * process-wide singleton state (the in-memory skill catalog), so it is
 * provided via a factory provider under the `SKILL_REGISTRY` token, mirroring
 * `AgentRuntimeModule`'s own `AgentConcurrencyGuard` factory-provider
 * precedent.
 *
 * KNOWN, TEMPORARY GAP (PR3): the 9 skills registered below are signed with
 * `object-skills.ts`'s own process-lifetime-generated Ed25519 keypair
 * (`OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM`), NOT the canonical
 * `SKILL_SDK_PUBLIC_KEY_PEM` constant `registerSkill()` curries -- no private
 * key matching that canonical constant exists anywhere in this repo (see
 * `skill-sdk-public-key.ts`'s own doc comment), so signing genuinely against
 * it is not possible today. A real key-management workflow (the canonical
 * public key's matching private key held securely by a release/CI process)
 * is a follow-up concern, not fixed in this PR.
 */
@Module({
  imports: [
    AgentRuntimeModule,
    ObjectsModule,
    NotetakerModule,
    ContextModule,
    SearchModule,
    CalendarModule,
    QAModule,
    CommandsModule,
    TriggerSuggestionsModule,
  ],
  providers: [
    {
      provide: SKILL_REGISTRY,
      useFactory: (
        objectsService: ObjectsService,
        meetingsService: MeetingsService,
        contextService: ContextService,
        connectedSearchService: ConnectedSearchService,
        calendarEventsService: CalendarEventsService,
        qaService: QAService,
        commandsService: CommandsService,
        triggerSuggestionsService: TriggerSuggestionsService,
        taskRecurrenceService: TaskRecurrenceService,
      ) => {
        const registry = new SkillRegistry();

        const objectSkillBuilders = [
          buildCreateObjectSkill,
          buildGetObjectSkill,
          buildQueryObjectsSkill,
          buildSetFieldValuesSkill,
          buildAddChecklistItemSkill,
          buildToggleChecklistItemSkill,
          buildScheduleTimeBlockSkill,
          buildRefreshAIFieldSkill,
          buildSetRecurrenceRuleSkill,
        ];
        for (const build of objectSkillBuilders) {
          registry.register(build(objectsService), OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM);
        }

        registry.register(
          buildGenerateNextRecurrenceSkill(taskRecurrenceService),
          MEETING_RECURRENCE_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildInviteMeetingBotSkill(meetingsService),
          MEETING_RECURRENCE_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildGetMeetingDetailsSkill(meetingsService),
          MEETING_RECURRENCE_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );

        registry.register(
          buildGetObjectContextSkill(contextService),
          CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildSearchConnectedSourcesSkill(connectedSearchService),
          CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildListCachedCalendarEventsSkill(calendarEventsService),
          CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );

        registry.register(
          buildAnswerQuestionSkill(qaService),
          AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildParseCommandSkill(commandsService),
          AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildProposeActionsFromMeetingSkill(commandsService),
          AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildRunTriggerSuggestionAnalysisSkill(triggerSuggestionsService),
          AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );
        registry.register(
          buildListCommandProposalsSkill(commandsService),
          AI_COMMAND_SKILLS_SIGNING_PUBLIC_KEY_PEM,
        );

        return registry;
      },
      inject: [
        ObjectsService,
        MeetingsService,
        ContextService,
        ConnectedSearchService,
        CalendarEventsService,
        QAService,
        CommandsService,
        TriggerSuggestionsService,
        TaskRecurrenceService,
      ],
    },
    SkillExecutionService,
  ],
  exports: [SkillExecutionService],
})
export class SkillsModule {}
