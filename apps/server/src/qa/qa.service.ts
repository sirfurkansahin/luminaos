import { Inject, Injectable } from '@nestjs/common';

import type { AIProvider } from '@luminaos/ai-gateway';

import { AI_PROVIDER } from '../ai/ai-provider.token.js';
import { AIUsageService } from '../ai/ai-usage.service.js';
import { answerQuestion } from '../ai/answer-question.js';
import { selectAIModel } from '../ai/select-ai-model.js';
import { SearchService } from '../search/search.service.js';

import type { QAPassage } from '../ai/answer-question.js';

/**
 * Top-N retrieved passages handed to `answerQuestion` as RAG context —
 * deliberately smaller than search's own user-facing `DEFAULT_LIMIT` (10,
 * see `../search/dto/search-workspace.schema.ts`): fewer, higher-signal
 * passages keep the prompt focused and cheap.
 */
const TOP_K = 5;

/**
 * F1-T15 PR4 (ADR-0014 §a/§b): orchestrates the RAG question-answering
 * flow -- `SearchService` retrieval, `AIUsageService`'s quota/lock/audit
 * discipline (same "once per operation" pattern as
 * `ObjectsService.performAIFieldRefresh`), `selectAIModel`, and
 * `answerQuestion` -- behind a single public method the controller calls.
 */
@Injectable()
export class QAService {
  constructor(
    private readonly searchService: SearchService,
    private readonly aiUsageService: AIUsageService,
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
  ) {}

  async answer(
    workspaceId: string,
    question: string,
  ): Promise<{ answer: string; sources: QAPassage[] }> {
    const searchResults = await this.searchService.search(workspaceId, question, TOP_K);

    const passages: QAPassage[] = searchResults.map((result) => ({
      objectId: result.objectId,
      title: result.title,
      snippet: result.snippet,
    }));

    return this.aiUsageService.withWorkspaceAILock(workspaceId, async () => {
      // Quota is checked EXACTLY ONCE per QA operation, before the provider
      // call -- same "once per operation" discipline as
      // `ObjectsService.performAIFieldRefresh`.
      await this.aiUsageService.assertAITokenQuotaNotExceeded(workspaceId);
      await this.aiUsageService.assertAICostBudgetNotExceeded(workspaceId);

      const model = selectAIModel({ outputType: 'qa' });

      return answerQuestion({
        provider: this.aiProvider,
        question,
        passages,
        model,
        recordUsage: (usage) =>
          this.aiUsageService.recordAIUsage(workspaceId, undefined, undefined, usage, model),
      });
    });
  }
}
