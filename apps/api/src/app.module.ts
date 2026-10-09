import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthenticationModule } from '@nestjs/authentication';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import {
  FileTemplateEngine,
  LogMailTransport,
  MailModule,
  SmtpTransport,
} from '@nestjs/mail';
import { join } from 'path';
import { minutes, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthThrottlerGuard } from './auth/auth-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: minutes(1), limit: 100 }]),
    PrismaModule,
    MailModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Your provider in production. In development, each email (links
        // included) is printed to the log.
        // Optional: without it, emails (links included) are printed to the log.
        const smtpUrl = configService.get<string>('SMTP_URL');

        return {
          transport: smtpUrl
            ? new SmtpTransport({ url: smtpUrl })
            : new LogMailTransport(),

          // The HTML templates in mail/templates, copied to dist by nest-cli.json
          templates: new FileTemplateEngine({
            dir: join(__dirname, 'mail/templates'),
          }),
          from:
            configService.get<string>('MAIL_FROM') ??
            'Ledger <no-reply@ledger.local>',
        };
      },
    }),
    AuthenticationModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const appUrl = configService.getOrThrow<string>('APP_URL');

        return {
          session: {
            absoluteTtl: '14d', // signed out after 14 days, however active,
            idleTtl: '3d', // or after 3 days without a request
            // The web app runs on another origin than the API.
            trustedOrigins: [appUrl],
          },
          emailVerification: {
            url: `${appUrl}/verify-email`,
          },
        };
      },
    }),
    UsersModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    // Registered in the root module so it runs before the authentication
    // guard: guessed credentials count against the limit too.
    { provide: APP_GUARD, useClass: AuthThrottlerGuard },
  ],
})
export class AppModule {}
