import { CurrentUser } from '@nestjs/authentication';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { User } from '../users/types/user.types';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/wallets.dto';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}
  // Get wallets for a user
  @Get()
  getUserWallets(@CurrentUser() user: User) {
    return this.walletsService.getUserWallets(user.id);
  }

  @Get(':walletId')
  getWalletById(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @CurrentUser() user: User,
  ) {
    return this.walletsService.getWalletById(walletId, user.id);
  }

  @Post()
  createUserWallet(
    @Body() createWalletDto: CreateWalletDto,
    @CurrentUser() user: User,
  ) {
    return this.walletsService.createUserWallet(
      createWalletDto.currency,
      user.id,
    );
  }
}
