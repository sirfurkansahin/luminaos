import {
  buildQueryResultTableSection,
  deriveWidgetColumns,
  renderArtifactHtml,
} from '@luminaos/artifacts';
import type { ArtifactType, ThemePresetName } from '@luminaos/artifacts';
import { querySpecSchema } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

import { ArtifactViewer } from './ArtifactViewer.js';
import { useLiveWidgetQuery } from '../../hooks/useLiveWidgetQuery.js';
import { useObjectQuery } from '../../hooks/useObjectsQuery.js';

/**
 * F3-T8 PR3 (sorgu -> canlı widget, ADR-0042 Karar f, spec Kabul Kriterleri)
 * -- reads the artifact object, tries to parse+validate its stored
 * `querySpec`, and when that succeeds polls live rows via
 * `useLiveWidgetQuery` and renders freshly-built HTML from them; on any
 * parse/schema failure it silently falls back to the object's own static
 * `fieldValues.htmlContent` snapshot.
 */
export interface LiveWidgetViewerProps {
  workspaceId: string;
  artifactObjectId: string;
}

function parseQuerySpec(raw: unknown): QuerySpec | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = querySpecSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function LiveWidgetViewer({ workspaceId, artifactObjectId }: LiveWidgetViewerProps) {
  const objectQuery = useObjectQuery(workspaceId, artifactObjectId);
  const object = objectQuery.data?.object;

  const querySpec = parseQuerySpec(object?.fieldValues.querySpec);
  const liveQuery = useLiveWidgetQuery(workspaceId, querySpec);

  if (object === undefined) {
    return null;
  }

  const staticHtmlContent =
    typeof object.fieldValues.htmlContent === 'string' ? object.fieldValues.htmlContent : '';

  let htmlContent = staticHtmlContent;
  if (querySpec !== undefined && liveQuery.data !== undefined && 'objects' in liveQuery.data) {
    try {
      const columns = deriveWidgetColumns(querySpec);
      const rows = liveQuery.data.objects.map((row) => ({
        title: row.title,
        fieldValues: row.fieldValues,
      }));
      const section = buildQueryResultTableSection(rows, columns);
      htmlContent = renderArtifactHtml(
        { title: object.title, sections: [section] },
        object.fieldValues.themePreset as ThemePresetName,
        object.fieldValues.artifactType as ArtifactType,
      );
    } catch {
      // Corrupted/unexpected themePreset|artifactType (or any other render
      // failure) fails closed to the static snapshot, same as an
      // unparseable querySpec above -- never crashes the viewer.
      htmlContent = staticHtmlContent;
    }
  }

  return <ArtifactViewer htmlContent={htmlContent} />;
}
