import {
  EmailVerificationService,
  Public,
  SignInService,
} from '@nestjs/authentication';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignInDto, SignUpDto } from './dto/auth.dto';
import { minutes, Throttle } from '@nestjs/throttler';

@Public()
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly signInService: SignInService,
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Post('sign-up')
  async signUp(@Body() body: SignUpDto) {
    const user = await this.authService.register(
      body.name,
      body.email,
      body.password,
    );
    await this.signInService.signIn(user.id, { method: 'password' });

    // The account already exists at this point, so a mail failure must not
    // turn the sign-up into an error: log it, and the customer can use
    // "resend" from their account.
    try {
      await this.emailVerificationService.send(user);
    } catch (error) {
      this.logger.error(
        `Could not send the verification email for user ${user.id}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    return user;
  }

  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  async signIn(@Body() body: SignInDto) {
    const user = await this.authService.login(body.email, body.password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const { session } = await this.signInService.signIn(user.id, {
      method: 'password',
    });

    return { mfaRequired: session.mfa === 'pending' };
  }
}
