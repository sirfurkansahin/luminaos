import { describe, expect, it } from 'vitest';

import { actorSchema, domainEventSchema, newDomainEventSchema } from './domain-event.js';

/**
 * A fully valid `DomainEvent` envelope, per F0-T6's plan
 * (`giggly-brewing-moore.md`): `version` is the stream-internal optimistic
 * concurrency position, *not* a payload schema version.
 */
function validDomainEvent(): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    streamId: '22222222-2222-4222-8222-222222222222',
    streamType: 'test-stream',
    workspaceId: '33333333-3333-4333-8333-333333333333',
    type: 'TestEventOccurred',
    version: 1,
    payload: { foo: 'bar' },
    actor: { type: 'user', id: '44444444-4444-4444-8444-444444444444' },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('actorSchema', () => {
  it('accepts a valid user actor', () => {
    const result = actorSchema.safeParse({ type: 'user', id: 'user-1' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid agent actor', () => {
    const result = actorSchema.safeParse({ type: 'agent', id: 'agent-1' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid system actor', () => {
    const result = actorSchema.safeParse({ type: 'system', id: 'system-1' });
    expect(result.success).toBe(true);
  });

  it('rejects a type outside the user|agent|system enum', () => {
    const result = actorSchema.safeParse({ type: 'robot', id: 'robot-1' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty id', () => {
    const result = actorSchema.safeParse({ type: 'user', id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra keys (.strict())', () => {
    const result = actorSchema.safeParse({ type: 'user', id: 'user-1', extra: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('domainEventSchema', () => {
  it('parses a fully valid envelope successfully', () => {
    const result = domainEventSchema.safeParse(validDomainEvent());
    expect(result.success).toBe(true);
  });

  describe('missing required fields', () => {
    const requiredFields = [
      'id',
      'streamId',
      'streamType',
      'workspaceId',
      'type',
      'version',
      'payload',
      'actor',
      'occurredAt',
    ] as const;

    for (const field of requiredFields) {
      it(`rejects an envelope missing "${field}"`, () => {
        const event = validDomainEvent();
        Reflect.deleteProperty(event, field);

        const result = domainEventSchema.safeParse(event);
        expect(result.success).toBe(false);
      });
    }
  });

  describe('UUID fields', () => {
    it('rejects an "id" that is not a valid UUID', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), id: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('rejects a "streamId" that is not a valid UUID', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        streamId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a "workspaceId" that is not a valid UUID', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        workspaceId: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('version', () => {
    it('rejects version 0', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), version: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects a negative version', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), version: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects a non-integer version', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), version: 1.5 });
      expect(result.success).toBe(false);
    });

    it('accepts a positive integer version', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), version: 42 });
      expect(result.success).toBe(true);
    });
  });

  describe('streamType / type length bounds', () => {
    it('rejects an empty streamType', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), streamType: '' });
      expect(result.success).toBe(false);
    });

    it('rejects a streamType longer than 100 characters', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        streamType: 'a'.repeat(101),
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty type', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), type: '' });
      expect(result.success).toBe(false);
    });

    it('rejects a type longer than 200 characters', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), type: 'a'.repeat(201) });
      expect(result.success).toBe(false);
    });
  });

  describe('payload', () => {
    it('rejects a payload that is a string instead of an object', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        payload: 'not-an-object',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a payload that is an array instead of a plain object', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), payload: ['a', 'b'] });
      expect(result.success).toBe(false);
    });

    it('rejects a null payload', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), payload: null });
      expect(result.success).toBe(false);
    });

    it('accepts an empty-but-present object payload', () => {
      const result = domainEventSchema.safeParse({ ...validDomainEvent(), payload: {} });
      expect(result.success).toBe(true);
    });
  });

  describe('actor', () => {
    it('rejects an actor whose type is outside the user|agent|system enum', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        actor: { type: 'robot', id: 'robot-1' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a missing actor', () => {
      const event = validDomainEvent();
      delete event.actor;
      const result = domainEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });

  describe('occurredAt', () => {
    it('rejects an occurredAt that is a string rather than a Date instance', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        occurredAt: '2026-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('strict mode (mass-assignment protection)', () => {
    it('rejects an envelope with an unknown extra top-level key', () => {
      const result = domainEventSchema.safeParse({
        ...validDomainEvent(),
        globalPosition: 123,
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('newDomainEventSchema', () => {
  it('parses an object that omits streamId and version', () => {
    const event = validDomainEvent();
    delete event.streamId;
    delete event.version;

    const result = newDomainEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('still rejects an object that includes streamId as an extra key (zod v4 .omit() on a .strict() base)', () => {
    const event = validDomainEvent();
    delete event.version;
    // `streamId` is deliberately left in: newDomainEventSchema must not accept
    // it, since callers of append() supply streamId as a separate argument,
    // not as part of the event body.

    const result = newDomainEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('still rejects an object that includes version as an extra key', () => {
    const event = validDomainEvent();
    delete event.streamId;
    // `version` is deliberately left in: the store assigns the version, the
    // caller must not be able to smuggle one in.

    const result = newDomainEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('rejects an object missing a still-required field such as "type"', () => {
    const event = validDomainEvent();
    delete event.streamId;
    delete event.version;
    delete event.type;

    const result = newDomainEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});
