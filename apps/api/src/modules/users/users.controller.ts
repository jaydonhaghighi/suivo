import { Controller, Get } from '@nestjs/common';

import { CurrentUser } from '../../common/auth/current-user.decorator';
import { UserContext } from '../../common/auth/user-context';

@Controller('users')
export class UsersController {
  @Get('me')
  me(@CurrentUser() user: UserContext): UserContext {
    return user;
  }
}
