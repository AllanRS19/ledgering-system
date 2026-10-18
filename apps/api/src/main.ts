import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// Money amounts are BigInt (minor units). JSON can't serialize BigInt
// natively, so we convert them to strings in responses.
BigInt.prototype.toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api/v1', {
    exclude: ['/health'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // The session cookie only travels cross-origin with credentials enabled.
  app.enableCors({
    origin: config.getOrThrow<string>('APP_URL'),
    credentials: true,
    // Browers only let JavaScript read response headers listed here, and the
    // web app needs to know when an answer is a replay
    exposedHeaders: ['Idempotent-Replayed'],
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Ledgering System API')
    .setDescription(
      'Double-entry wallet ledger with idempotent transfers and webhooks',
    )
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, { useGlobalPrefix: true });

  const port = Number(config.get<number>('PORT') ?? 4000);
  await app.listen(port);
  console.log(`API running on http://localhost:${port}/api/v1`);
  console.log(`Swagger docs on http://localhost:${port}/api/v1/docs`);
}

void bootstrap();
