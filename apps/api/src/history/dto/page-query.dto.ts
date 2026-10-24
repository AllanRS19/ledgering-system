import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE_SIZE } from '../../common/constants';

/**
 * The query-string parameters every history list shares. Everything in a
 * query string arrives as text: @Type turns `limit` into a number first, and
 * then it is validated like any other value.
 */
export class PageQueryDto {
  // The default (DEFAULT_PAGE_SIZE) is applied in the service.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  // Only the length is checked here: decodeCursor does the real validation.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  // Inclusive start. `strict` also rejects impossible dates such as 2026-02-30.
  // Kept as text: the service turns it into a Date.
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  // Exclusive end. The rule "from before to" involves two fields, so the
  // service checks it.
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
