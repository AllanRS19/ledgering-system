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
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthThrottlerGuard } from './auth/auth-throttler.guard';
import { WalletsModule } from './wallets/wallets.module';
import { TransactionsModule } from './transactions/transactions.module';
import { LedgerExceptionFilter } from './ledger/ledger-exception.filter';
import { HistoryModule } from './history/history.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          ttl: minutes(1),
          // 100 requests a minute per client by default. Raise it ONLY for
          // local load tests: a high limit in production defeats the point.
          limit: Number(configService.get<string>('THROTTLE_LIMIT') ?? 100),
        },
      ],
    }),
    PrismaModule,
    MailModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
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
    WalletsModule,
    TransactionsModule,
    HistoryModule,
  ],
  controllers: [HealthController],
  providers: [
    // Registered in the root module so it runs before the authentication
    // guard: guessed credentials count against the limit too.
    { provide: APP_GUARD, useClass: AuthThrottlerGuard },
    { provide: APP_FILTER, useClass: LedgerExceptionFilter },
  ],
})
export class AppModule {}
