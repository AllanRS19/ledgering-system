import {
  CurrentUser,
  EmailVerificationService,
  Public,
} from '@nestjs/authentication';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { VerifyEmailDto } from './dto/auth.dto';
import { minutes, Throttle } from '@nestjs/throttler';
import type { User } from '../users/types/user.types';

@Controller('auth/email')
export class EmailVerificationController {
  constructor(
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  // Called by the page the link opens, which POSTs the token from its URL.
  @Public()
  @Post('verify')
  @HttpCode(200)
  async verifyEmail(@Body() { token }: VerifyEmailDto) {
    const verified = await this.emailVerificationService.verify(token);

    if (!verified) {
      throw new BadRequestException('Invalid or expired link');
    }

    return {
      email: verified.email,
      emailVerified: true,
    };
  }

  // "Send the link again", to the signed-in customer's current address.
  @Throttle({ default: { limit: 3, ttl: minutes(15) } })
  @Post('verification')
  @HttpCode(202)
  async resend(@CurrentUser() user: User) {
    if (user.emailVerified) {
      throw new ConflictException('Email address is already verified');
    }
    await this.emailVerificationService.send(user);
  }
}
