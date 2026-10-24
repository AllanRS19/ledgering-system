import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';

/** Builds a cursor-looking string from any value, the way an attacker could. */
const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');

describe('cursor', () => {
  const id = randomUUID();

  describe('a cursor that encodeCursor produced', () => {
    it.each(['transaction', 'entry'] as const)(
      'comes back as the same id for the %s list',
      (kind) => {
        expect(decodeCursor(kind, encodeCursor(kind, id))).toBe(id);
      },
    );

    it('is safe to put in a URL', () => {
      expect(encodeCursor('transaction', id)).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is refused on the other list', () => {
      expect(() =>
        decodeCursor('entry', encodeCursor('transaction', id)),
      ).toThrow(BadRequestException);

      expect(() =>
        decodeCursor('transaction', encodeCursor('entry', id)),
      ).toThrow(BadRequestException);
    });
  });

  describe('a cursor that is not valid', () => {
    it.each([
      ['an empty string', ''],
      ['a string that is too long', 'a'.repeat(201)],
      ['text that is not base64 JSON', b64('this is not json')],
      ['characters outside base64url', '%%%***'],
      ['JSON null', b64('null')],
      ['a JSON array', b64([1, 2, 3])],
      ['a JSON string', b64('"hello"')],
      ['a missing version', b64({ k: 'transaction', id })],
      ['another version', b64({ v: 2, k: 'transaction', id })],
      ['a missing kind', b64({ v: 1, id })],
      ['an unknown kind', b64({ v: 1, k: 'wallet', id })],
      ['a missing id', b64({ v: 1, k: 'transaction' })],
      ['an id that is a number', b64({ v: 1, k: 'transaction', id: 5 })],
      ['an id that is not a UUID', b64({ v: 1, k: 'transaction', id: 'abc' })],
    ])('is rejected: %s', (_label, cursor) => {
      expect(() => decodeCursor('transaction', cursor)).toThrow(
        BadRequestException,
      );
    });
  });
});
