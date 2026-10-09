import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeEmail } from '../../common/helpers';

const toNormalizedEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeEmail(value) : value;

export class SignUpDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  name!: string;

  @IsEmail()
  @Transform(toNormalizedEmail)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

export class SignInDto {
  @IsEmail()
  @Transform(toNormalizedEmail)
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class VerifyEmailDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
