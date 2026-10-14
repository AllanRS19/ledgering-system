import type { SignInService } from '@nestjs/authentication';
import { UnauthorizedException } from '@nestjs/common';
import { SessionsController } from './sessions.controller';

// The package's decorators and service become empty stand-ins: only the
// controller's own decisions are tested here.
jest.mock('@nestjs/authentication', () => ({
  Public: () => () => undefined,
  CurrentUser: () => () => undefined,
  SignInService: class SignInService {},
}));

function setup() {
  const signInService = {
    signOut: jest.fn<Promise<boolean>, []>(),
    signOutEverywhere: jest.fn<Promise<void>, [string]>(),
  };

  const controller = new SessionsController(
    signInService as unknown as SignInService,
  );

  return { controller, signInService };
}

describe('SessionsController', () => {
  describe('signOut', () => {
    it('resolves with nothing when a session was ended', async () => {
      const { controller, signInService } = setup();
      signInService.signOut.mockResolvedValue(true);

      await expect(controller.signOut()).resolves.toBeUndefined();
      expect(signInService.signOut).toHaveBeenCalledTimes(1);
    });

    it('answers 401 when there was no session to end', async () => {
      const { controller, signInService } = setup();
      signInService.signOut.mockResolvedValue(false);

      await expect(controller.signOut()).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('never signs out the other devices', async () => {
      const { controller, signInService } = setup();
      signInService.signOut.mockResolvedValue(true);

      await controller.signOut();

      expect(signInService.signOutEverywhere).not.toHaveBeenCalled();
    });
  });

  describe('signOutEverywhere', () => {
    it("ends the signed-in user's sessions, and only theirs", async () => {
      const { controller, signInService } = setup();
      signInService.signOutEverywhere.mockResolvedValue(undefined);

      await expect(
        controller.signOutEverywhere('user-1'),
      ).resolves.toBeUndefined();

      expect(signInService.signOutEverywhere).toHaveBeenCalledTimes(1);
      expect(signInService.signOutEverywhere).toHaveBeenCalledWith('user-1');
      expect(signInService.signOut).not.toHaveBeenCalled();
    });
  });
});
