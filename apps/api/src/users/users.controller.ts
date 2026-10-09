import { CurrentUser } from '@nestjs/authentication';
import { Controller, Get } from '@nestjs/common';
import type { User } from './types/user.types';

@Controller('users')
export class UsersController {
  // The signed-in user, as loaded by SessionAuth.validate().
  @Get('me')
  getCurrentUser(@CurrentUser() user: User) {
    return user;
  }
}
