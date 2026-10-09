import { Module } from '@nestjs/common';
import { SessionAuth } from './session-auth.provider';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationMailer } from './email-verification.mailer';
import { EmailVerificationController } from './email-verification.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, EmailVerificationController],
  providers: [SessionAuth, AuthService, EmailVerificationMailer],
})
export class AuthModule {}
