import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

/**
 * Which list a cursor belongs to. A cursor from one list is refused on the
 * other: the ids come from different tables, so using one on the wrong list
 * would silently return an empty page.
 */
export type CursorKind = 'transaction' | 'entry';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 200;

const invalidCursor = () => new BadRequestException('The cursor is not valid');

/**
 * An opaque bookmark: "the previous page ended at this row". Clients store it
 * and send it back unchanged. What is inside (here a version, a kind and an
 * id) can change later without breaking them, because they never look in.
 */
export function encodeCursor(kind: CursorKind, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: kind, id }),
  ).toString('base64url');
}

/**
 * Gives back the id the cursor points at, or answers 400 if the cursor is not
 * one that encodeCursor produced for this kind of list. Base64 decoding in
 * Node is lenient and ignores bad characters, so the JSON and the shape of
 * the content are what really validate it.
 */
export function decodeCursor(kind: CursorKind, cursor: string): string {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor();
  }

  const { v, k, id } = parsed as { v?: unknown; k?: unknown; id?: unknown };

  if (
    v !== CURSOR_VERSION ||
    k !== kind ||
    typeof id !== 'string' ||
    !isUUID(id)
  ) {
    throw invalidCursor();
  }

  return id;
}
