import type { LuminaObject } from '@luminaos/core-objects';
import { AppError } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

export class ApiError extends AppError {}

export interface ObjectWithFieldValues extends LuminaObject {
  fieldValues: Record<string, unknown>;
}

export type QueryResult =
  | { objects: ObjectWithFieldValues[]; nextCursor?: string }
  | { groups: { groupValue: string; count: number; items: ObjectWithFieldValues[] }[] };

interface ServerErrorBody {
  error: { code: string; message: string };
}

function isServerErrorBody(value: unknown): value is ServerErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    if (isServerErrorBody(body)) {
      throw new ApiError(body.error.message, body.error.code, response.status);
    }
    throw new ApiError('Beklenmeyen bir sunucu hatası oluştu', 'UNKNOWN_ERROR', response.status);
  }

  return (await response.json()) as T;
}

export function postObjectsQuery(workspaceId: string, querySpec: QuerySpec): Promise<QueryResult> {
  return request<QueryResult>(`/workspaces/${encodeURIComponent(workspaceId)}/objects/query`, {
    method: 'POST',
    body: JSON.stringify(querySpec),
  });
}

export function patchFieldValues(
  workspaceId: string,
  objectId: string,
  values: Record<string, unknown>,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/fields`,
    {
      method: 'PATCH',
      body: JSON.stringify({ values }),
    },
  );
}

export function createObject(
  workspaceId: string,
  input: { objectType: string; title: string },
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}
