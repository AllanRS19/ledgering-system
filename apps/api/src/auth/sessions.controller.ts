import { CurrentUser, Public, SignInService } from '@nestjs/authentication';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

@Controller('auth')
export class SessionsController {
  constructor(private readonly signInService: SignInService) {}

  // Public, so signing out never depends on the state of the session (for
  // example one still waiting for a second factor, if you add that later).
  // signOut() ends the session in THIS browser's cookie and clears the cookie.
  // It returns false when there was no session to end.
  @Public()
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(): Promise<void> {
    if (!(await this.signInService.signOut())) {
      throw new UnauthorizedException();
    }
  }

  // Ends every session of the user, on every device, including this one.
  @Post('sign-out-everywhere')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOutEverywhere(@CurrentUser('id') userId: string): Promise<void> {
    await this.signInService.signOutEverywhere(userId);
  }
}
